import { NextResponse } from 'next/server';
import ModelRegistry from '@/lib/models/registry';
import UploadManager from '@/lib/uploads/manager';
import {
  rejectUnsupportedUpload,
  UnsupportedUploadError,
} from '@/lib/uploads/accepted';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const files = formData.getAll('files') as File[];
    const embeddingModel = formData.get('embedding_model_key') as string;
    const embeddingModelProvider = formData.get('embedding_model_provider_id') as string;

    if (!embeddingModel || !embeddingModelProvider) {
      return NextResponse.json(
        { message: 'Missing embedding model or provider' },
        { status: 400 },
      );
    }

    /* Before the embedding model loads: a PNG gets its answer at once, and
       a model that cannot load (no huggingface.co) cannot hide it. */
    const rejected = rejectUnsupportedUpload(files);

    if (rejected) {
      return NextResponse.json({ message: rejected }, { status: 415 });
    }

    const registry = new ModelRegistry();

    const model = await registry.loadEmbeddingModel(embeddingModelProvider, embeddingModel);

    const uploadManager = new UploadManager({
      embeddingModel: model,
    })

    const processedFiles = await uploadManager.processFiles(files);

    return NextResponse.json({
      files: processedFiles,
    });
  } catch (error) {
    console.error('Error uploading file:', error);

    if (error instanceof UnsupportedUploadError) {
      return NextResponse.json({ message: error.message }, { status: 415 });
    }

    /* The reason, not "An error has occurred.": the toast shows this text,
       and it is the only place a failed model download or parse is visible
       to the user. */
    return NextResponse.json(
      {
        message:
          error instanceof Error && error.message
            ? `Upload failed: ${error.message}`
            : 'An error has occurred.',
      },
      { status: 500 },
    );
  }
}
