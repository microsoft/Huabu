/**
 * Mock canvas data for development
 */

import { getCanvasDb } from './canvas.db.js';

export const MOCK_CANVAS_ID = 'default-canvas';

export function ensureMockCanvas(): void {
  const db = getCanvasDb();

  const existing = db
    .prepare('SELECT canvas_id FROM canvases WHERE canvas_id = ?')
    .get(MOCK_CANVAS_ID);

  if (existing) return;

  const mockState = {
    nodes: [
      // --- 1. Text Node  ---
      {
        id: 'node-text-1',
        type: 'text',
        position: { x: 500, y: -400 },
        data: {
          label: 'Sensemaking Research',
          content:
            'This board contains the preliminary research for the HCI project.\nFocus on the relationship between data foraging and schematizing.',
        },
        style: { width: 300, height: 160 },
      },

      // --- 2. Note Node  ---
      {
        id: 'node-note-1',
        type: 'note',
        position: { x: 1000, y: -200 },
        data: {
          content:
            '⚠️ TODO:\n1. Verify the PDF citations.\n2. Update the video link.\n3. Send draft to supervisor.',
        },
        style: { width: 220, height: 220 },
      },

      // --- 3. Image Node  ---
      {
        id: 'node-image-1',
        type: 'image',
        position: { x: 1000, y: 0 },
        data: {
          src: 'https://placehold.co/600x400/png',
          label: 'Fig 1. The Data/Frame Theory of Sensemaking',
        },
      },

      // --- 4. Frame Node  ---
      {
        id: 'frame-1',
        type: 'frame',
        position: { x: 500, y: 400 },
        data: {
          label: 'Reference Materials',
        },
        style: { width: 460, height: 240 },
        zIndex: -1,
      },

      // --- 5. Web Node  ---
      {
        id: 'node-web-1',
        type: 'web',
        position: { x: 0, y: 60 },
        data: {
          src: 'https://en.wikipedia.org/wiki/Sensemaking',
          label: 'Wikipedia: Sensemaking',
        },
        style: { width: 460, height: 300 },
      },

      // --- 6. PDF Node ---
      {
        id: 'node-pdf-1',
        type: 'pdf',
        position: { x: 500, y: -140 },
        data: {
          src: 'https://pdfobject.com/pdf/sample.pdf',
          label: 'Klein_1998_Data_Frame_Theory.pdf',
        },
        style: { width: 460, height: 500 },
      },

      // --- 7. Video Node  ---
      {
        id: 'node-video-1',
        type: 'video',
        position: { x: 0, y: 400 },
        data: {
          src: 'https://www.w3schools.com/html/mov_bbb.mp4',
          source: 'External Resource',
        },
        style: { width: 400, height: 240 },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'node-text-1',
        target: 'node-image-1',
        label: 'illustrates',
      },
      {
        id: 'edge-2',
        source: 'node-text-1',
        target: 'frame-1',
        animated: true,
        label: 'references',
      },
      {
        id: 'edge-3',
        source: 'node-note-1',
        target: 'node-image-1',
        style: { stroke: '#f59e0b' },
      },
    ],
  };

  const timestamp = Date.now();

  db.prepare(
    `INSERT INTO canvases (
      canvas_id, workspace_id, title, version, state_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    MOCK_CANVAS_ID,
    'default-workspace',
    'Default Canvas',
    0,
    JSON.stringify(mockState),
    timestamp,
    timestamp,
  );

  console.log('✅ Created mock canvas:', MOCK_CANVAS_ID);
}
