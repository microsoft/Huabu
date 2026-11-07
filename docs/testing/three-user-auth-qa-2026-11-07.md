# Three-user authentication and application QA checklist

Requested by the user on 2026-11-07. Reviewed checkout: `/home/kiki/Projects/Sediment`, branch `feat/228-member-agents`, head `f40a6ff89897a7dc12e8487b215ceced7810e118`, [PR #357](https://github.com/microsoft/Huabu/pull/357). This is an audit and test run; findings are recorded for review. The owner updates this checklist as evidence arrives.

## Fixtures and boundaries

- [x] F01 — Create three disposable Auth0 database users: Member A, Member B, and Administrator C. Use the existing Bubble SPA and real browser PKCE. Sign C in before granting system ownership through the documented Bubble grant endpoint; a membership grant alone does not make an administrator. A separate private bootstrap owner performs only fixture setup.
- [x] F02 — Use separate disposable PostgreSQL databases, data/config directories, and backend processes for backend and UI stories. Leave members initially ungranted in the UI run so admission is exercised through People. Preserve the user-owned local frontend.
- [x] F03 — Keep passwords, provider tokens, cookies, and connection credentials in private temporary files only. Record sanitized outcomes and reproduction evidence in this checklist and the PR.

## Backend stories — backend subagent

- [x] B01 — Admission and administration: both ungranted users receive access-required refusals; C admits them; members cannot list or mutate People; an administrator cannot accidentally revoke their own access through the member switch.
- [x] B02 — Private ownership: A, B, and C get independent personal Workspace preferences and Spaces; member create/edit/list/search and direct-ID reads stay scoped; cross-member Workspace activation and private Space access are refused. Verify administrator Space management access against its documented system-owner role.
- [x] B03 — Sharing lifecycle: C grants B viewer access to A's Workspace, then editor access, then revokes it. Verify viewer reads/SSE/search but cannot write; editor saves content but cannot rename/delete; revocation removes access and activation on the next request.
- [x] B04 — Personal configuration: all three users have private general/model/service settings and keys. The administrator's system permissions do not expose another person's private settings or ambient deployment credentials.
- [x] B05 — Devices and Profiles: attach user-owned test devices over the real Gateway WebSocket; check discovery, direct lookups, changes, deletion, file browsing, hostname/canonical placement, and administrator cross-user denials. Device credentials must not authenticate ordinary HTTP routes.
- [x] B06 — Credential reset: resetting A's credentials refuses their old reconnect/reachback and disconnects their device, leaves B's device usable, and never permits B to reclaim A's device identity.
- [x] B07 — Revocation while active: revoke a member or Workspace role while requests/streams are active; verify next-request enforcement and stream shutdown within the documented 30-second bound.
- [x] B08 — Restart and persistence: replace the owned backend process, preserving its database/data/signing configuration; verify identities, grants, Workspace preferences, Space contents, personal settings, and device ownership persist without cross-user exposure.

## Browser stories — UI subagent

- [x] U01 — Real sign-in and admission: C signs in as administrator, A/B see Access required, and C grants access through Settings → People. Members enter the application without being given administrator UI.
- [x] U02 — Private editing: A and B create and edit their own Spaces using the UI, reload, and retain content. Their Home/search/navigation and direct links do not reveal the other's private content; C also has their own personal Workspace.
- [x] U03 — Shared access: C changes Workspace roles through People. B sees the granted Workspace, can read as viewer, can edit content as editor, and cannot rename/delete without management rights. Remove access and verify B's active UI updates safely.
- [x] U04 — Settings and device surfaces: each account opens General, Agent settings, Services, and Devices and Agents; private values stay separate; People and deployment surfaces are shown only to C; foreign Profile/device actions are refused. Exercise the default Built-In Agent configuration/error path when no personal model is configured, if feasible; record paid/external agent execution separately.
- [x] U05 — Membership revocation and recovery: C revokes A while A has the app open; A is gated and cannot keep editing. Regrant access through People and verify recovery preserves account identity and handles retained edits/errors safely.
- [x] U06 — Session lifecycle: observe refresh-token rotation, concurrent-tab renewal, reload, recovery after deliberately removing the Huabu cookie, and same-account reauthentication. Check account changes cannot reuse another user's cached data or pending writes.
- [x] U07 — Logout: local logout clears cookies and peer renewal state; provider logout reaches Auth0, returns to Huabu unauthenticated, and ends the provider session. Verify another person's session is unaffected.
- [x] U08 — Visual and interaction review: capture and inspect administrator People, Access required, member settings, private editor, shared viewer/editor and error/revocation states at desktop and narrow widths. Check focus/keyboard use, overflow, disabled controls, loading/error copy, and permission affordances. Record route, viewport, and fixture state for every capture.

## Full regression and quality verification

- [x] V01 — Backend subagent runs `pnpm --filter @huabu/server test` and `pnpm run test:storage-backends` using the documented disposable PostgreSQL/Azurite path; record complete counts, intentional skips, failures, and environment limits.
- [x] V02 — UI subagent runs `pnpm --filter @huabu/web test`; record complete counts and any failures, including first-error reproduction.
- [x] V03 — Root runs remaining workspace-package tests and repository quality checks from CI: lint, format, typecheck, i18n, Agent Team skill checks, and license headers. Run prerequisite workspace builds before checks that consume generated outputs.
- [x] V04 — Root runs the repository build with CI documentation environment settings; report exact outcome. Treat packaged desktop and long-duration provider expiry as unrun unless separately exercised.
- [x] V05 — Screenshot reviewer inspects every captured image against existing components/specification; record visual findings with severity and image/location. No separate approved design was supplied for this audit.

## Closeout

- [x] C01 — Reproduce each backend/UI finding independently where practical, distinguish product defects from fixtures or harness errors, and record severity, source pointers, steps, expected behavior, and observed behavior.
- [x] C02 — Delete all three cloud users and verify absence; stop only owned runtimes/containers; remove temporary secrets/browser state/data while retaining sanitized evidence and inspected screenshots.
- [x] C03 — Update this checklist and post a head-scoped PR comment with test results, findings, screenshot evidence, and unrun limits. Commit the completed checklist without credentials or private runtime artifacts.

## Results and findings

**Completed: one P1 and four P2 UI findings. No backend product defect was reproduced.** All checklist items were exercised; checked means the check ran and its evidence was recorded, including checks that discovered a defect. No application fixes were made in this audit.

### Verification

| Check                                                                                                          | Result                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server unit/integration: `pnpm --filter @huabu/server test`                                                    | 3,227 passed, 29 skipped, 2 todo; 261 files passed, one skipped.                                                                                                                                                                                               |
| Web: `pnpm --filter @huabu/web test`                                                                           | 5,275 passed across 378 files outside the sandbox.                                                                                                                                                                                                             |
| Remaining packages: `pnpm -r --filter '!@huabu/server' --filter '!@huabu/web' --if-present --no-bail run test` | 1,527 passed, one desktop todo. Total unit tests passed: **10,029**.                                                                                                                                                                                           |
| PostgreSQL/Azurite: `pnpm run test:storage-backends`                                                           | 518 passed, one folder-specific skip across 17 files.                                                                                                                                                                                                          |
| CI quality checks                                                                                              | Lint passed with 390 existing warnings; format, typecheck, i18n, Agent Team tests/validation, and license-header checks passed.                                                                                                                                |
| Full CI build                                                                                                  | `DOCS_BASE_PATH=/Huabu/ DOCS_CANONICAL_ORIGIN=https://microsoft.github.io pnpm run build` passed.                                                                                                                                                              |
| Live backend B01–B08                                                                                           | Three real Auth0 actors; private namespaces/settings/keys/devices/Profiles, sharing, content CAS, credentials/reset/reclaim, revocation and restart checks passed. Real Gateway transport fixtures were used; external/paid Agent execution was not performed. |
| Revocation timing                                                                                              | Normal SSE EOF **29,992.615 ms after completed HTTP 204**; **30,006.397 ms from request start**, including 13.782 ms request processing. Revoked Space access returned 403 and Admin stayed authorized.                                                        |
| Extra token boundary checks                                                                                    | Management API token refused by identity and session routes; malformed cookie and anonymous identity refused. Four checks returned 401 without issuing a cookie.                                                                                               |
| Live UI U01–U08                                                                                                | Admission, private editing/persistence, role changes, personal preferences, revocation/regrant, rotation/two-tab renewal, cookie recovery, main-tab account change and local/provider logout exercised. Five UI findings below.                                |
| Visual evidence                                                                                                | **31 unique screenshots inspected**: 27 main UI, two independent focus, two independent account-binding captures. No visible credentials. Zero uncaught application page errors in the UI run. Seven reviewed captures are preserved below.                    |

The first sandboxed web run had a subprocess timeout in FarZoomText. Its exact focused host rerun and complete documented host suite passed without changing assertions. Agent Team/header checks also required host execution after sandboxed git subprocesses were denied; their exact reruns passed. These were environment failures, not product findings.

Fixture corrections: the first live fixtures pre-created an unbound federated administrator ID, causing a collision suffix on registration. The corrected fixtures first register the real administrator, then grant system ownership through `POST /bubble/v1/grants`. A backend privacy marker for Admin overlapped A's marker; distinct markers and a targeted privacy/restart rerun passed. UI locator, relative-URL and response-envelope errors were corrected and retained as harness history; they are not counted as product defects.

### S05 — P1: a ready peer tab retains A's data and writes under B after account change

**Reproduce:** sign A in and open a second ready `/spaces` tab. In the main tab, sign A out through provider logout and sign B in. Bring the old peer to the foreground. Native identity/Workspace APIs now resolve B, while application identity and Workspace stores remain A; A's private Home/title remain visible, no account gate blocks the main UI, and New Space stays enabled. Clicking that real UI control creates a Space under B (POST 201; B reads 200; A reads 404), while the peer still holds A's cached identity/Workspace. A second agent reproduced the same sequence in a fresh browser context and removed its own proof Space afterward.

**Expected:** reload or close the old account's application before cached data or pending edits can be reused. **Observed:** stale A UI is interactive against B's shared cookie. Backend authorization correctly follows B; this is a UI account-binding failure, not a bypass of server principal checks. The before-action Home had no inert elements; the resulting Canvas had two inert collapsed panels, which did not block its main controls. The actual UI 201 write and independent API/read-back comparisons establish the defect, rather than a raw inert-element count.

Source: [SignInGate.tsx](../../apps/web/src/components/Shell/SignInGate.tsx#L196) detects changed principals only when `check()` executes, but [its foreground listeners](../../apps/web/src/components/Shell/SignInGate.tsx#L325) apply only to `noAccess`; [OIDC peer messages](../../apps/web/src/utils/oidcLogin.ts#L153) clear token memory without invalidating the ready gate. [Session adoption](../../apps/web/src/api/identity.ts#L141) replaces the shared cookie. Evidence: [before action](three-user-auth-qa-2026-11-07/peer-stale-account-before-action.png), [after action](three-user-auth-qa-2026-11-07/peer-stale-account-after-action.png), and two independent sanitized store/HTTP ownership traces in the local audit artifacts.

### S03 — P2: editing affordances ignore viewer/editor permissions

**Reproduce:** grant B viewer access to A's Workspace, open A's Note preview and type content. The preview is editable and shows attempted changes, but the content PUT returns 403 and stored content remains unchanged. Grant editor, type a Space rename and submit; Canvas PUT returns 403, the stored title remains unchanged, and the attempted title stays visible. The viewer error misleadingly suggests a locked/unwritable file and offers Retry for an authorization failure.

**Expected:** viewer Notes are read-only, title editing requires management permission, and errors explain lost/absent permission. Source: [CanvasMenu.tsx](../../apps/web/src/components/Panels/Header/CanvasMenu.tsx#L126), [ExpandedNodePanel.tsx](../../apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx#L660) hardcodes `readOnly={false}`, [NotePreview.tsx](../../apps/web/src/components/Nodes/note/NotePreview.tsx#L127) honors that prop, and [error copy](../../apps/web/src/i18n/resources/en/common.json#L1663). Independent [generic save enforcement](../../apps/server/src/modules/canvas/canvas.route.ts#L1523) and the [shared regression scenario](../../apps/server/src/modules/identity/multi-user.scenarios.ts#L466) confirmed backend writes are guarded. Evidence: [editor rename](three-user-auth-qa-2026-11-07/editor-rename-denied.png), [viewer edit](three-user-auth-qa-2026-11-07/viewer-edit-denied.png).

### S02 — P2: Settings does not contain keyboard focus

**Reproduce:** Administrator `/spaces` → Settings → General. Shift+Tab from the first navigation control reaches the background Space Actions button. Tab from the final Input mode control leaves document focus; another Tab reaches the background Application menu. The dialog stays `aria-modal="true"`, and the outside controls are not inert.

**Expected:** Tab and Shift+Tab wrap inside the modal, as specified by the [WAI modal keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Independently reproduced with live keyboard/DOM evidence. Source: [SettingsModal.tsx](../../apps/web/src/components/Settings/SettingsModal.tsx#L144) handles Escape and focus restoration without Tab containment. Evidence: [focus escape](three-user-auth-qa-2026-11-07/settings-focus-escape.png).

### S01 — P2: light-theme guidance has insufficient contrast

**Reproduce:** an ungranted signed-in member at `/`, the administrator's first Workspace chooser at `/setup`, or a missing/inaccessible Space. Small meaningful guidance uses `#767676` on `#f5f5f5`, measured in rendered pixels at **4.166:1**, below the [WCAG normal-text minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). This finding is limited to measured light-theme combinations; People copy on white and unmeasured dark combinations are not included.

Source: [text/background tokens](../../apps/web/src/index.css#L78), [SignInGate.tsx](../../apps/web/src/components/Shell/SignInGate.tsx#L437), [WorkspaceSetupPage.tsx](../../apps/web/src/pages/WorkspaceSetupPage.tsx#L76), [CanvasPage.tsx](../../apps/web/src/pages/CanvasPage/CanvasPage.tsx#L430). Evidence: [no-access guidance](three-user-auth-qa-2026-11-07/no-access-contrast.png), plus the reviewed setup/not-found captures.

### S04 — P2: first-run Built-In Agent guidance requires an external Agent

**Reproduce:** a newly admitted member has an empty personal model provider/authentication and no external Profiles. Open New Conversation; it displays “Connect an external Agent before starting a new conversation.” Built-In Pi's personal provider/key setup is available in Agent settings and is the [documented new-user default](../proposals/multi-user-service.md#private-agents-and-settings-for-every-user), so guidance should offer that setup rather than imply an external Agent is required.

Source: [default conversation binding](../../apps/web/src/store/acpProfilesStore.ts#L351) and [English error copy](../../apps/web/src/i18n/resources/en/common.json#L1662). No provider invocation occurred. This finding covers the unconfigured first-run state; configured/paid Built-In turns were not tested. The two toasts in the capture resulted from two intentional clicks and are not a duplicate-notification finding. Evidence: [unconfigured conversation](three-user-auth-qa-2026-11-07/unconfigured-new-conversation.png).

### Evidence and closeout

Seven selected screenshots were inspected by the delegated reviewer, checked for visible credentials, and copied byte-for-byte from the originals. The local sanitized audit directory `/tmp/huabu-three-user-20261107` retains complete test logs, source evidence, screenshot manifests/reviews and outcome reports; credentials and runtime data were removed. No raw transcript, user password, bearer token, cookie, API key, or private runtime configuration is committed.

All three cloud users were deleted (204) and independently verified absent (404). Owned frontend/backend/coordinators and PostgreSQL containers stopped; the existing user frontend at IPv4 localhost:5173 remained available. Temporary generated credentials, browser processes, private data/config and PostgreSQL state were removed. The local `.env` keeps the user's existing provider credentials and correct Bubble SPA ID.

**Unrun limits:** live Entra was not repeated in this three-user Auth0 run; [the earlier two-user Entra result](https://github.com/microsoft/Huabu/pull/357#issuecomment-6700870589) remains separate. Paid/external Agent turns, personal-model-configured Built-In conversation, populated device/Profile UI cards, natural long-duration expiry, packaged desktop, and seeded queued-unsaved-write replay were not exercised. Backend device/Profile ownership used real Gateway fixtures. Default tests intentionally skipped FFmpeg-gated media and folder-specific cases; existing todos include LLM credential-write compensation/rollback coverage and one desktop case. These gaps do not weaken the demonstrated fresh 201 wrong-account UI creation.
