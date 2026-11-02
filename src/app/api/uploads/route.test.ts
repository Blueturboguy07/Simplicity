import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/* POST /api/uploads end to end, with the real UploadManager writing into a
   throw-away DATA_DIR and a fake embedding model. Before this fix the PNG
   case returned 500 {"message":"An error has occurred."} (v0.1.3, Mac and
   Windows runs in scratchpad/bugfix/simplicity-uploads/NOTES.md). */

/* UploadManager.uploadsDir is a static computed when the module loads, so
   DATA_DIR must be set before the route is imported (dynamic import below). */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-uploads-'));
process.env.DATA_DIR = dataDir;
const uploadsDir = path.join(dataDir, 'data', 'uploads');

const embedText = vi.fn(async (texts: string[]) =>
  texts.map(() => [0.1, 0.2, 0.3]),
);

vi.mock('@/lib/models/registry', () => ({
  default: class {
    async loadEmbeddingModel() {
      return { embedText };
    }
  },
}));

const { POST } = await import('./route');
const UploadManager = (await import('@/lib/uploads/manager')).default;
const { UnsupportedUploadError } = await import('@/lib/uploads/accepted');

const txt = () =>
  new File(['secret PELICAN-7421\n'], 'notes.txt', { type: 'text/plain' });
const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pic.png', {
    type: 'image/png',
  });

const post = (files: File[], withModel = true) => {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  if (withModel) {
    form.append('embedding_model_provider_id', 'p1');
    form.append('embedding_model_key', 'Xenova/all-MiniLM-L6-v2');
  }
  return POST(
    new Request('http://127.0.0.1/api/uploads', { method: 'POST', body: form }),
  );
};

const storedFiles = () =>
  fs.existsSync(uploadsDir)
    ? fs.readdirSync(uploadsDir).filter((f) => f !== 'uploaded_files.json')
    : [];

beforeEach(() => {
  embedText.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/uploads', () => {
  it('png -> 415 with a message that names the file and the accepted types; nothing stored', async () => {
    const before = storedFiles().length;
    const res = await post([png()]);

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      message: 'pic.png: images are not supported yet. Upload a PDF, DOCX or TXT.',
    });
    expect(storedFiles().length).toBe(before);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('txt -> 200 with a fileId; the file and its chunks are on disk', async () => {
    const res = await post([txt()]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      fileName: 'notes.txt',
      fileExtension: 'txt',
    });
    expect(body.files[0].fileId).toMatch(/^[0-9a-f]{32}$/);

    const chunks = UploadManager.getFileChunks(body.files[0].fileId);
    expect(chunks[0].content).toContain('PELICAN-7421');
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('txt with no MIME type (Windows) -> 200', async () => {
    const res = await post([new File(['hello'], 'notes.txt', { type: '' })]);
    expect(res.status).toBe(200);
  });

  it('txt + png in one request -> 415 and the txt is not stored either', async () => {
    const before = storedFiles().length;
    const res = await post([txt(), png()]);

    expect(res.status).toBe(415);
    expect((await res.json()).message).toContain('pic.png');
    expect(storedFiles().length).toBe(before);
  });

  it('no embedding model -> 400, as before', async () => {
    const res = await post([txt()], false);
    expect(res.status).toBe(400);
  });

  it('a real failure -> 500 with the reason, not "An error has occurred."', async () => {
    embedText.mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND huggingface.co'),
    );
    const res = await post([txt()]);

    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe(
      'Upload failed: getaddrinfo ENOTFOUND huggingface.co',
    );
  });
});

describe('UploadManager.processFiles', () => {
  it('checks every file before it writes any (one bad file in a multi-select)', async () => {
    const manager = new UploadManager({ embeddingModel: { embedText } as any });
    const before = storedFiles().length;

    await expect(manager.processFiles([txt(), png()])).rejects.toBeInstanceOf(
      UnsupportedUploadError,
    );
    expect(storedFiles().length).toBe(before);
    expect(embedText).not.toHaveBeenCalled();
  });
});
