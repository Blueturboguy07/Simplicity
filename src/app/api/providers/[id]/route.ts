import ModelRegistry from '@/lib/models/registry';
import { NextRequest } from 'next/server';
import configManager from '@/lib/config';
import { ConfigModelProvider } from '@/lib/config/types';
import { declinePublik } from '@/lib/publik/provision';
import { maskProviderConfig, mergeSecretConfig } from '@/lib/config/secrets';

export const DELETE = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    if (!id) {
      return Response.json(
        {
          message: 'Provider ID is required.',
        },
        {
          status: 400,
        },
      );
    }

    /* Deleting the publik connection is "use my own key instead" — pin the
       choice so it never comes back on its own. Every other provider is
       removed exactly as before. */
    const doomed = (
      configManager.getConfig('modelProviders', []) as ConfigModelProvider[]
    ).find((p) => p.id === id);
    if (doomed?.type === 'publik') {
      declinePublik();
    } else {
      const registry = new ModelRegistry();
      await registry.removeProvider(id);
    }

    return Response.json(
      {
        message: 'Provider deleted successfully.',
      },
      {
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('An error occurred while deleting provider', err.message);
    return Response.json(
      {
        message: 'An error has occurred.',
      },
      {
        status: 500,
      },
    );
  }
};

export const PATCH = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const body = await req.json();
    const { name, config } = body;
    const { id } = await params;

    if (!id || !name || !config) {
      return Response.json(
        {
          message: 'Missing required fields.',
        },
        {
          status: 400,
        },
      );
    }

    /* Settings shows a stored key masked and sends the field back empty
       or still masked when the user did not change it: keep the stored
       key in that case instead of saving the mask over it. */
    const existing = (
      configManager.getConfig('modelProviders', []) as ConfigModelProvider[]
    ).find((p) => p.id === id);
    const merged =
      existing && config && typeof config === 'object'
        ? mergeSecretConfig(existing.type, existing.config, config)
        : config;

    const registry = new ModelRegistry();

    const updatedProvider = await registry.updateProvider(id, name, merged);

    return Response.json(
      {
        provider: maskProviderConfig(updatedProvider),
      },
      {
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('An error occurred while updating provider', err.message);
    return Response.json(
      {
        message: 'An error has occurred.',
      },
      {
        status: 500,
      },
    );
  }
};
