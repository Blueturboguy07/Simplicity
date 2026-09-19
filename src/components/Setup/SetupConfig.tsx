import {
  ConfigModelProvider,
  UIConfigField,
  UIConfigSections,
} from '@/lib/config/types';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import ProviderPicker from './ProviderPicker';
import PublikCard from './PublikCard';
import ModelProvider from '../Settings/Sections/Models/ModelProvider';
import { useChat } from '@/lib/hooks/useChat';
import { PublikAction, usePublikStatus } from '@/lib/hooks/usePublikStatus';
import { pickDefaultModel } from '@/lib/models/catalog';

const SetupConfig = ({
  configSections,
  setupState,
  setSetupState,
}: {
  configSections: UIConfigSections;
  setupState: number;
  setSetupState: (state: number) => void;
}) => {
  const [providers, setProviders] = useState<ConfigModelProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFinishing, setIsFinishing] = useState(false);
  const { setChatModelProvider, setEmbeddingModelProvider } = useChat();
  /* The packaged build's publik card. `status.available` is false on dev,
     Docker and source builds, and the card simply does not render. */
  const {
    status: publik,
    busy: publikBusy,
    act: publikAct,
  } = usePublikStatus([setupState]);

  const fetchProviders = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/providers');
      if (!res.ok) throw new Error('Failed to fetch providers');

      const data = await res.json();
      setProviders(data.providers || []);
    } catch (error) {
      console.error('Error fetching providers:', error);
      toast.error('Failed to load providers');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (setupState === 2) {
      fetchProviders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupState]);

  /* accept / retry / reconnect change the provider list server-side (a
     mint adds the publik entry; decline removes it) — re-read it so the
     "Your connections" list and the Start button agree with the card. */
  const onPublikAction = async (action: PublikAction) => {
    const next = await publikAct(action);
    /* "later" only records that the plan CTA was shown; the provider list
       is unchanged, so there is nothing to re-read. */
    if (action !== 'later') await fetchProviders();
    return next;
  };

  /* Pick the models instead of asking.
   *
   * Chat: the first model of the first provider they connected — they can
   * change it from the selector in the chat box, which is where switching
   * models actually belongs.
   *
   * Embedding: always the bundled Transformers model. It runs locally in the
   * app, costs nothing, and needs no key, so there is no decision here worth
   * putting in front of someone. It reranks search results before they reach
   * the chat model (see baseSearch.ts) — an implementation detail, not a
   * preference, which is why other answer engines never surface it either.
   */
  const autoSelectModels = async () => {
    /* One policy for the wizard and the chat box: pickDefaultModel — "Best"
       (a key the user entered themselves wins; publik next; then local),
       else the first catalog row, else the first model of the first
       provider. */
    const chatPick =
      pickDefaultModel(
        providers.filter(
          (p) => p.type !== 'transformers' && p.chatModels.length > 0,
        ),
      ) ??
      (() => {
        const first = providers.find(
          (p) => p.type !== 'transformers' && p.chatModels.length > 0,
        );
        return first
          ? { providerId: first.id, key: first.chatModels[0].key }
          : null;
      })();
    if (chatPick) {
      localStorage.setItem('chatModelProviderId', chatPick.providerId);
      localStorage.setItem('chatModelKey', chatPick.key);
      setChatModelProvider(chatPick);
    }

    /* Embeddings are never a user-facing choice — they only rerank search
       results, and a worse reranker just means worse answers. Prefer Ollama's
       local model (the installer pulls nomic-embed-text alongside the chat
       model); fall back to the bundled Transformers model so that someone who
       connected only an API key still gets ranked results instead of raw
       keyword order. Nothing registers Transformers on a fresh install, so
       without that fallback there'd be no embedding model at all. */
    let embeddingProvider =
      providers.find(
        (p) => p.type === 'ollama' && p.embeddingModels.length > 0,
      ) ?? providers.find((p) => p.embeddingModels.length > 0);

    if (!embeddingProvider) {
      try {
        const res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'transformers',
            name: 'Built-in',
            config: {},
          }),
        });
        if (res.ok) embeddingProvider = (await res.json()).provider;
      } catch {
        /* Non-fatal: search still works, just with unranked results. */
      }
    }

    if (embeddingProvider?.embeddingModels?.length) {
      localStorage.setItem('embeddingModelProviderId', embeddingProvider.id);
      localStorage.setItem(
        'embeddingModelKey',
        embeddingProvider.embeddingModels[0].key,
      );
      setEmbeddingModelProvider({
        providerId: embeddingProvider.id,
        key: embeddingProvider.embeddingModels[0].key,
      });
    }
  };

  const handleFinish = async () => {
    try {
      setIsFinishing(true);
      await autoSelectModels();

      const res = await fetch('/api/config/setup-complete', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to complete setup');

      window.location.reload();
    } catch (error) {
      console.error('Error completing setup:', error);
      toast.error('Failed to complete setup');
      setIsFinishing(false);
    }
  };

  /* The publik connection has its own card above; listing it again under
     "Your connections" would show a key field for something that is not
     pasted. */
  const visibleProviders = providers.filter(
    (p) => p.name.toLowerCase() !== 'transformers' && p.type !== 'publik',
  );
  const hasProviders =
    providers.filter(
      (p) => p.name.toLowerCase() !== 'transformers' && p.chatModels.length > 0,
    ).length > 0;
  const showPublik = Boolean(publik?.available);

  return (
    <div className="w-[95vw] md:w-[80vw] lg:w-[65vw] mx-auto px-2 sm:px-4 md:px-6 flex flex-col space-y-6">
      {setupState === 2 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { duration: 0.5, delay: 0.1 },
          }}
          className="w-full h-[calc(95vh-80px)] bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-xl shadow-sm flex flex-col overflow-hidden"
        >
          <div className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 md:py-6">
            <div className="mb-4 md:mb-6 pb-3 md:pb-4 border-b border-light-200 dark:border-dark-200">
              <p className="text-xs sm:text-sm font-medium text-black dark:text-white">
                {showPublik
                  ? 'Simplicity uses publik API'
                  : 'Choose a provider'}
              </p>
              <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5">
                {showPublik
                  ? 'Ready in one click — or connect your own provider below. You can add more later.'
                  : 'Connect at least one to get started. You can add more later.'}
              </p>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8 md:py-12">
                <p className="text-xs sm:text-sm text-black/50 dark:text-white/50">
                  Loading providers...
                </p>
              </div>
            ) : (
              <>
                {showPublik && publik && publik.state !== 'declined' && (
                  <PublikCard
                    status={publik}
                    busy={publikBusy}
                    onAction={onPublikAction}
                  />
                )}
                {showPublik && (
                  <p className="mb-3 text-[10px] sm:text-xs font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                    Or connect your own provider
                  </p>
                )}
                <ProviderPicker
                  modelProviders={configSections.modelProviders}
                  providers={providers}
                  setProviders={setProviders}
                />

                {visibleProviders.length > 0 && (
                  <div className="mt-6 md:mt-8 space-y-3 md:space-y-4">
                    <p className="text-[10px] sm:text-xs font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                      Your connections
                    </p>
                    {visibleProviders.map((provider) => (
                      <ModelProvider
                        key={`provider-${provider.id}`}
                        fields={
                          (configSections.modelProviders.find(
                            (f) => f.key === provider.type,
                          )?.fields ?? []) as UIConfigField[]
                        }
                        modelProvider={provider}
                        setProviders={setProviders}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      )}

      {/* There is no model-selection step. The chat model is chosen for the
          user and swapped from the selector in the chat box; the embedding
          model is never a user-facing choice at all. */}

      <div className="flex flex-row items-center justify-between pt-2">
        <a></a>
        {setupState === 2 && (
          <motion.button
            initial={{ opacity: 0, x: 10 }}
            animate={{
              opacity: 1,
              x: 0,
              transition: { duration: 0.5 },
            }}
            onClick={handleFinish}
            disabled={!hasProviders || isLoading || isFinishing}
            className="flex flex-row items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 rounded-lg bg-[#24A0ED] text-white hover:bg-[#1e8fd1] active:scale-95 transition-all duration-200 font-medium text-xs sm:text-sm disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            <span>{isFinishing ? 'Finishing…' : 'Start searching'}</span>
            <Check className="w-4 h-4 md:w-[18px] md:h-[18px]" />
          </motion.button>
        )}
      </div>
    </div>
  );
};

export default SetupConfig;
