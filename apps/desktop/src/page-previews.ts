// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ipcMain, session, shell, WebContentsView } from 'electron';

import { isSameOrigin } from './server-target.js';

import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Rectangle,
  Session,
  WebContents,
} from 'electron';

/**
 * Other people's web pages, shown in the Preview panel.
 *
 * A page gets a view of its own rather than an `<iframe>` in the application's
 * page. It then runs in its own process and in a session of its Space's
 * previewed pages alone, with no preload bridge, and is a top-level document: a site that refuses to be framed is
 * shown without removing the header by which it refuses.
 *
 * The application's page says where the view goes; the view is drawn above it.
 */

/** A Space shows one page per Preview group; this bounds a runaway caller. */
const MAX_PER_OWNER = 8;
const CAPTURE_TIMEOUT_MS = 300;

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PagePreviewState {
  id: string;
  loading: boolean;
  error: string | null;
}

export type PagePreviewResult = { ok: true } | { ok: false; error: string };

/** The address to show, or `null` when it is not another site's web page. */
export function previewUrl(raw: unknown, appOrigin: string): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // The application's own documents are framed by its page, where the
  // Server's sandbox policy for stored documents applies.
  if (isSameOrigin(url.href, appOrigin)) return null;
  return url.href;
}

export function parsePageRect(raw: unknown): PageRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((value) => typeof value === 'number' && isFinite(value)))
    return null;
  return { x, y, width, height } as PageRect;
}

/**
 * Where in the window a page goes: `rect` is in the owner page's CSS pixels,
 * `frame` is where the owner sits in the window. The result never leaves the
 * owner, so a page cannot be laid over the title bar. `null` when nothing of
 * it would show.
 */
export function placeWithin(
  rect: PageRect,
  zoom: number,
  frame: Rectangle,
): Rectangle | null {
  const left = Math.max(frame.x, frame.x + Math.round(rect.x * zoom));
  const top = Math.max(frame.y, frame.y + Math.round(rect.y * zoom));
  const right = Math.min(
    frame.x + frame.width,
    frame.x + Math.round((rect.x + rect.width) * zoom),
  );
  const bottom = Math.min(
    frame.y + frame.height,
    frame.y + Math.round((rect.y + rect.height) * zoom),
  );
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const guarded = new WeakSet<Session>();

/** A previewed page is given no device permission and saves no download. */
function guardPreviewSession(webSession: Session): void {
  if (guarded.has(webSession)) return;
  guarded.add(webSession);
  webSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', (event) => {
    event.preventDefault();
    console.warn('[page-previews] Blocked a download from a previewed page.');
  });
}

interface Preview {
  id: string;
  owner: WebContents;
  view: WebContentsView;
  /** The address last asked for, which the page may since have left. */
  url: string;
  rect: PageRect | null;
  /** Changes whenever the page is placed, so a slow capture can tell. */
  placement: number;
}

export interface PagePreviewHost {
  /**
   * The session a Space's previewed pages share: kept between launches, apart
   * from the application's own and from every other Space's.
   */
  partitionOf(owner: WebContents): string;
  /** Where a Space's page sits in the window; `null` unless it is in front. */
  frameOf(owner: WebContents): Rectangle | null;
  /** The application's window shortcuts, which a focused page must not eat. */
  handleInput(event: Electron.Event, input: Electron.Input): void;
}

export class PagePreviews {
  private previews = new Map<string, Preview>();

  constructor(
    private win: BrowserWindow,
    private appOrigin: string,
    private host: PagePreviewHost,
  ) {}

  private key(owner: WebContents, id: string): string {
    return `${owner.id}:${id}`;
  }

  private find(owner: WebContents, id: unknown): Preview | undefined {
    return typeof id === 'string'
      ? this.previews.get(this.key(owner, id))
      : undefined;
  }

  private allowed(url: string): boolean {
    return previewUrl(url, this.appOrigin) !== null;
  }

  show(owner: WebContents, rawId: unknown, rawUrl: unknown): void {
    if (typeof rawId !== 'string' || !rawId || rawId.length > 128)
      throw new Error('Invalid page identity');
    const url = previewUrl(rawUrl, this.appOrigin);
    if (!url) throw new Error('Only another site’s web page can be shown');
    const existing = this.find(owner, rawId);
    if (existing) {
      if (existing.url !== url) this.load(existing, url);
      return;
    }
    let owned = 0;
    for (const preview of this.previews.values())
      if (preview.owner === owner) owned += 1;
    if (owned >= MAX_PER_OWNER) throw new Error('Too many pages are open');

    const webSession = session.fromPartition(this.host.partitionOf(owner));
    guardPreviewSession(webSession);
    const view = new WebContentsView({
      webPreferences: {
        session: webSession,
        // No preload: the page has no bridge to the application.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        navigateOnDragDrop: false,
        safeDialogs: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    const preview: Preview = {
      id: rawId,
      owner,
      view,
      url,
      rect: null,
      placement: 0,
    };
    this.previews.set(this.key(owner, rawId), preview);
    this.win.contentView.addChildView(view);

    const contents = view.webContents;
    const report = (state: Omit<PagePreviewState, 'id'>) => {
      if (!owner.isDestroyed())
        owner.send('page-preview:state', { id: rawId, ...state });
    };
    contents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target))
        void shell
          .openExternal(target)
          .catch((error: unknown) =>
            console.error('[page-previews] Could not open a link:', error),
          );
      return { action: 'deny' };
    });
    // The page may follow links, but only to other web pages.
    contents.on('will-navigate', (event, target) => {
      if (!this.allowed(target)) event.preventDefault();
    });
    contents.on('will-redirect', (event, target, _inPlace, isMainFrame) => {
      if (isMainFrame && !this.allowed(target)) event.preventDefault();
    });
    contents.on('before-input-event', (event, input) =>
      this.host.handleInput(event, input),
    );
    // `did-stop-loading` follows a failed load too.
    let failure: string | null = null;
    contents.on('did-start-loading', () => {
      failure = null;
      report({ loading: true, error: null });
    });
    contents.on('did-stop-loading', () =>
      report({ loading: false, error: failure }),
    );
    contents.on(
      'did-fail-load',
      (_event, code, description, _url, isMainFrame) => {
        // -3 is a load the page itself replaced.
        if (!isMainFrame || code === -3) return;
        failure = description || `Error ${code}`;
        report({ loading: false, error: failure });
      },
    );
    contents.on('render-process-gone', (_event, details) =>
      report({ loading: false, error: `The page stopped: ${details.reason}` }),
    );
    // A click in the page never reaches the application's page, which is how
    // that page would have known to close an open menu.
    contents.on('focus', () => {
      if (!owner.isDestroyed()) owner.send('page-preview:focus', rawId);
    });
    this.load(preview, url);
  }

  private load(preview: Preview, url: string): void {
    preview.url = url;
    // A failure is reported by `did-fail-load`.
    void preview.view.webContents.loadURL(url).catch(() => {});
  }

  place(owner: WebContents, id: unknown, rawRect: unknown): void {
    const preview = this.find(owner, id);
    if (!preview) return;
    preview.placement += 1;
    preview.rect = parsePageRect(rawRect);
    this.apply(preview);
  }

  /**
   * Take the page out of the way and hand back a picture of it, for the
   * application's page to show in its place: a menu or dialog there cannot be
   * drawn above the page itself.
   */
  async hide(owner: WebContents, id: unknown): Promise<string | null> {
    const preview = this.find(owner, id);
    if (!preview) return null;
    preview.placement += 1;
    const placement = preview.placement;
    let picture: string | null = null;
    if (preview.rect && this.host.frameOf(owner)) {
      const contents = preview.view.webContents;
      const image = await Promise.race([
        contents.capturePage().catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS),
        ),
      ]);
      if (image && !image.isEmpty())
        picture = `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`;
    }
    // Placed again while the picture was taken: it stays.
    if (preview.placement !== placement) return picture;
    if (this.previews.get(this.key(owner, preview.id)) !== preview)
      return picture;
    preview.rect = null;
    this.apply(preview);
    return picture;
  }

  reload(owner: WebContents, id: unknown): void {
    const preview = this.find(owner, id);
    if (!preview) return;
    this.load(preview, preview.url);
  }

  close(owner: WebContents, id: unknown): void {
    const preview = this.find(owner, id);
    if (preview) this.destroy(preview);
  }

  /** A Space that closed or reloaded takes its pages with it. */
  closeAll(owner: WebContents): void {
    for (const preview of [...this.previews.values()])
      if (preview.owner === owner) this.destroy(preview);
  }

  private destroy(preview: Preview): void {
    this.previews.delete(this.key(preview.owner, preview.id));
    if (!this.win.isDestroyed())
      this.win.contentView.removeChildView(preview.view);
    if (!preview.view.webContents.isDestroyed())
      preview.view.webContents.close({ waitForBeforeUnload: false });
  }

  private apply(preview: Preview): void {
    if (this.win.isDestroyed() || preview.owner.isDestroyed()) return;
    const frame = this.host.frameOf(preview.owner);
    const bounds =
      frame && preview.rect
        ? placeWithin(preview.rect, preview.owner.getZoomFactor(), frame)
        : null;
    if (bounds) preview.view.setBounds(bounds);
    // A hidden view that kept the keyboard would swallow what is typed next.
    else if (preview.view.webContents.isFocused()) preview.owner.focus();
    preview.view.setVisible(bounds !== null);
  }

  /** The window was resized, or another Tab came to the front. */
  layout(): void {
    for (const preview of this.previews.values()) this.apply(preview);
  }

  dispose(): void {
    for (const preview of [...this.previews.values()]) this.destroy(preview);
  }
}

export function registerPagePreviewIpc(
  resolve: (
    event: IpcMainInvokeEvent | IpcMainEvent,
  ) => PagePreviews | null | undefined,
): void {
  const previews = (event: IpcMainInvokeEvent | IpcMainEvent): PagePreviews => {
    const found = resolve(event);
    if (!found) throw new Error('Pages are shown only by a Space');
    return found;
  };
  ipcMain.handle(
    'page-preview:show',
    (event, id: unknown, url: unknown): PagePreviewResult => {
      try {
        previews(event).show(event.sender, id, url);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  ipcMain.handle('page-preview:hide', async (event, id: unknown) => {
    try {
      return await previews(event).hide(event.sender, id);
    } catch (error) {
      console.error('[page-previews] hide:', error);
      return null;
    }
  });
  const listen = (
    name: string,
    run: (previews: PagePreviews, owner: WebContents, args: unknown[]) => void,
  ) => {
    ipcMain.on(name, (event, ...args: unknown[]) => {
      try {
        run(previews(event), event.sender, args);
      } catch (error) {
        console.error(`[page-previews] ${name}:`, error);
      }
    });
  };
  listen('page-preview:place', (pages, owner, args) =>
    pages.place(owner, args[0], args[1]),
  );
  listen('page-preview:reload', (pages, owner, args) =>
    pages.reload(owner, args[0]),
  );
  listen('page-preview:close', (pages, owner, args) =>
    pages.close(owner, args[0]),
  );
}
