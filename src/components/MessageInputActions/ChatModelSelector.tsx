'use client';

import { Check, ChevronDown, Cpu, Loader2, Sparkles } from 'lucide-react';
import {
  BEST_KEY,
  ResolvedRow,
  availableRows,
  resolveBest,
} from '@/lib/models/catalog';
import { cn } from '@/lib/utils';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useEffect, useMemo, useState } from 'react';
import { MinimalProvider } from '@/lib/models/types';
import { useChat } from '@/lib/hooks/useChat';
import { AnimatePresence, motion } from 'motion/react';
import ProviderLogo from '../ui/ProviderLogo';

/* The model picker, shaped like Perplexity's (2026-07): Best on top with a
   subtitle, then a flat list of models — logo, real name, New/Free badges,
   check on the selected row, and a nested "Thinking" toggle under a selected
   reasoning-capable model. No locks anywhere: what's connected is usable. */

const THINKING_STORAGE_KEY = 'thinkingEnabled';

const ModelSelector = () => {
  const [providers, setProviders] = useState<MinimalProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [thinking, setThinking] = useState(true);

  const { setChatModelProvider, chatModelProvider } = useChat();

  useEffect(() => {
    setThinking(localStorage.getItem(THINKING_STORAGE_KEY) !== '0');

    const loadProviders = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/providers');

        if (!res.ok) {
          throw new Error('Failed to fetch providers');
        }

        const data: { providers: MinimalProvider[] } = await res.json();
        setProviders(data.providers);
      } catch (error) {
        console.error('Error loading providers:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadProviders();
  }, []);

  const rows = useMemo(() => availableRows(providers), [providers]);
  const mainRows = rows.filter((r) => !r.row.extra);
  const extraRows = rows.filter((r) => r.row.extra);

  /* Models a provider fetched from its own /models endpoint — honest keys the
     catalog doesn't know about (e.g. an OpenAI-Compatible connection serving
     "llama-3.1-70b"). Nothing resolves through the catalog, so they get their
     own section below it. */
  const dynamicRows = useMemo<ResolvedRow[]>(() => {
    const out: ResolvedRow[] = [];
    providers.forEach((p) => {
      const coveredKeys = new Set(
        rows.filter((r) => r.providerId === p.id).map((r) => r.key),
      );
      const seen = new Set<string>();
      p.chatModels.forEach((m) => {
        if (coveredKeys.has(m.key) || seen.has(m.key)) return;
        seen.add(m.key);
        out.push({
          row: {
            id: `dynamic-${p.id}-${m.key}`,
            name: m.name || m.key,
            icon: p.type,
            candidates: [],
          },
          providerId: p.id,
          key: m.key,
          free: false,
        });
      });
    });
    return out;
  }, [providers, rows]);

  const selectableRows = useMemo(
    () => [...rows, ...dynamicRows],
    [rows, dynamicRows],
  );

  const best = resolveBest(providers);
  const isBestSelected = chatModelProvider?.key === BEST_KEY;

  const selectedRow = useMemo(
    () =>
      selectableRows.find(
        (r) =>
          r.providerId === chatModelProvider?.providerId &&
          r.key === chatModelProvider?.key,
      ) ?? null,
    [selectableRows, chatModelProvider],
  );

  /* Button label: the row name, with a grayed "Thinking" suffix when the
     selected model reasons — mirroring "GPT-5.6 Terra Thinking". */
  const currentName = isBestSelected
    ? 'Best'
    : (selectedRow?.row.name ?? 'Model');
  const showThinkingSuffix =
    !isBestSelected && !!selectedRow?.row.thinking && thinking;

  const selectRow = (r: ResolvedRow) => {
    setChatModelProvider({ providerId: r.providerId, key: r.key });
    localStorage.setItem('chatModelProviderId', r.providerId);
    localStorage.setItem('chatModelKey', r.key);
  };

  const selectBest = () => {
    if (!best) return;
    /* Store the sentinel so the choice stays "Best" across restarts, but send
       the resolved model — the API needs a real one. */
    localStorage.setItem('chatModelKey', BEST_KEY);
    localStorage.setItem('chatModelProviderId', best.providerId);
    setChatModelProvider({ providerId: best.providerId, key: best.key });
  };

  const toggleThinking = () => {
    const next = !thinking;
    setThinking(next);
    localStorage.setItem(THINKING_STORAGE_KEY, next ? '1' : '0');
  };

  const renderRow = (r: ResolvedRow) => {
    const isSelected =
      !isBestSelected &&
      chatModelProvider?.providerId === r.providerId &&
      chatModelProvider?.key === r.key;

    return (
      <div key={r.row.id}>
        <button
          onClick={() => selectRow(r)}
          type="button"
          className={cn(
            'w-full px-3 py-2.5 flex items-center justify-between text-start duration-200 cursor-pointer transition rounded-lg group',
            isSelected
              ? 'bg-light-secondary dark:bg-dark-secondary'
              : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
          )}
        >
          <div className="flex items-center space-x-2.5 min-w-0 flex-1">
            <ProviderLogo
              providerKey={r.row.icon}
              size={16}
              className={cn(
                'shrink-0',
                isSelected
                  ? 'text-black dark:text-white'
                  : 'text-black/60 dark:text-white/60 group-hover:text-black dark:group-hover:text-white',
              )}
            />
            <p
              className={cn(
                'text-[13px] truncate',
                isSelected
                  ? 'text-black dark:text-white font-medium'
                  : 'text-black/80 dark:text-white/80 group-hover:text-black dark:group-hover:text-white',
              )}
            >
              {r.row.name}
            </p>
            {r.row.badge && (
              <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold bg-teal-500/15 text-teal-600 dark:text-teal-400">
                {r.row.badge}
              </span>
            )}
            {r.free && (
              <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                Free
              </span>
            )}
          </div>
          {isSelected && (
            <Check size={14} className="text-black dark:text-white shrink-0" />
          )}
        </button>

        {/* Nested Thinking toggle, directly under the selected reasoning
            model — where Perplexity puts it. */}
        {isSelected && r.row.thinking && (
          <div className="pl-10 pr-3 pb-1.5 flex items-center justify-between">
            <p className="text-xs text-black/70 dark:text-white/70">Thinking</p>
            <button
              type="button"
              role="switch"
              aria-checked={thinking}
              onClick={toggleThinking}
              className={cn(
                'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                thinking ? 'bg-teal-500' : 'bg-black/20 dark:bg-white/20',
              )}
            >
              <span
                className={cn(
                  'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                  thinking ? 'translate-x-[18px]' : 'translate-x-[3px]',
                )}
              />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <PopoverButton
            type="button"
            className="flex flex-row items-center gap-1.5 active:border-none hover:bg-light-200 hover:dark:bg-dark-200 px-2 py-1.5 rounded-lg focus:outline-none headless-open:text-black dark:headless-open:text-white text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white"
          >
            {isBestSelected ? (
              <Sparkles size={15} className="text-sky-500 shrink-0" />
            ) : (
              <Cpu size={15} className="text-sky-500 shrink-0" />
            )}
            <span className="text-xs font-medium max-w-[150px] truncate">
              {currentName}
              {showThinkingSuffix && (
                <span className="text-black/40 dark:text-white/40">
                  {' '}
                  Thinking
                </span>
              )}
            </span>
            <ChevronDown size={14} className="shrink-0 opacity-60" />
          </PopoverButton>
          <AnimatePresence>
            {open && (
              <PopoverPanel
                className="absolute z-10 w-[250px] sm:w-[280px] right-0"
                static
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className="origin-top-right bg-light-primary dark:bg-dark-primary border rounded-xl border-light-200 dark:border-dark-200 w-full flex flex-col shadow-lg overflow-hidden"
                >
                  <div className="max-h-[360px] overflow-y-auto p-1.5">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2
                          className="animate-spin text-black/40 dark:text-white/40"
                          size={22}
                        />
                      </div>
                    ) : selectableRows.length === 0 && !best ? (
                      <div className="text-center py-12 px-4 text-black/60 dark:text-white/60 text-sm">
                        No models connected
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {best && (
                          <button
                            type="button"
                            onClick={selectBest}
                            className={cn(
                              'px-3 py-2.5 flex items-center justify-between text-start transition rounded-lg',
                              isBestSelected
                                ? 'bg-light-secondary dark:bg-dark-secondary'
                                : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                            )}
                          >
                            <div className="flex items-center space-x-2.5">
                              <Sparkles
                                size={16}
                                className={cn(
                                  'shrink-0',
                                  isBestSelected
                                    ? 'text-black dark:text-white'
                                    : 'text-black/60 dark:text-white/60',
                                )}
                              />
                              <div>
                                <p
                                  className={cn(
                                    'text-[13px]',
                                    isBestSelected
                                      ? 'text-black dark:text-white font-medium'
                                      : 'text-black/80 dark:text-white/80',
                                  )}
                                >
                                  Best
                                </p>
                                <p className="text-[10px] text-black/50 dark:text-white/50">
                                  Selects the best available model
                                </p>
                              </div>
                            </div>
                            {isBestSelected && (
                              <Check
                                size={14}
                                className="text-black dark:text-white shrink-0"
                              />
                            )}
                          </button>
                        )}

                        {mainRows.map(renderRow)}

                        {extraRows.length > 0 && (
                          <>
                            <div className="h-px bg-light-200 dark:bg-dark-200 my-1.5" />
                            {extraRows.map(renderRow)}
                          </>
                        )}

                        {dynamicRows.length > 0 && (
                          <>
                            <div className="h-px bg-light-200 dark:bg-dark-200 my-1.5" />
                            <p className="px-3 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                              From your connections
                            </p>
                            {dynamicRows.map(renderRow)}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default ModelSelector;
