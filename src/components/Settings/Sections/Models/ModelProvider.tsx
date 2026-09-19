import {
  UIConfigField,
  ConfigModelProvider,
  StringUIConfigField,
} from '@/lib/config/types';
import ProviderLogo from '@/components/ui/ProviderLogo';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import DeleteProvider from './DeleteProviderDialog';
import { usePublikStatus } from '@/lib/hooks/usePublikStatus';
import { StatusLine } from '@/components/Setup/PublikCard';
import {
  BalanceLine,
  PlanCtaLink,
  WhyItCosts,
} from '@/components/Publik/PlanCta';

/* Settings only ever needs to show and edit a connection's credentials — which
   fields those are (an API key, a base URL, both, or none) comes straight from
   the provider's own config schema, so there is nothing provider-specific to
   special-case here. Model enablement, model lists and per-model add/remove
   used to live in this card; that has moved to the chat box's model picker,
   which is the only place models are actually chosen. */
const ModelProvider = ({
  modelProvider,
  setProviders,
  fields,
}: {
  modelProvider: ConfigModelProvider;
  fields: UIConfigField[];
  setProviders: React.Dispatch<React.SetStateAction<ConfigModelProvider[]>>;
}) => {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  /* publik is provisioned, not pasted: its key is shown masked and
     read-only, there is no Save, and the card carries the balance line.
     "Remove connection" is the "use my own key instead" path from here. */
  const isPublik = modelProvider.type === 'publik';
  const { status: publik } = usePublikStatus([isPublik]);

  useEffect(() => {
    /* Auto-registered providers (transformers, a connected Claude account)
       can arrive with no stored config at all — a fresh install renders this
       card before anything was ever saved. */
    const stored = modelProvider.config ?? {};
    const initial: Record<string, any> = {};
    fields.forEach((field) => {
      initial[field.key] = stored[field.key] ?? field.default ?? '';
    });
    setConfig(initial);
  }, [fields, modelProvider.config]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/providers/${modelProvider.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: modelProvider.name,
          config,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to update provider');
      }

      const data: ConfigModelProvider = (await res.json()).provider;

      setProviders((prev) =>
        prev.map((p) => (p.id === modelProvider.id ? data : p)),
      );

      toast.success('Connection saved.');
    } catch (error) {
      console.error('Error updating provider:', error);
      toast.error('Failed to save connection.');
    } finally {
      setLoading(false);
    }
  };

  const errorMessage =
    modelProvider.chatModels.find((m) => m.key === 'error')?.name ??
    modelProvider.embeddingModels.find((m) => m.key === 'error')?.name;

  return (
    <div
      key={modelProvider.id}
      className="border border-light-200 dark:border-dark-200 rounded-lg overflow-hidden bg-light-primary dark:bg-dark-primary"
    >
      <div className="px-5 py-3.5 flex flex-row justify-between w-full items-center border-b border-light-200 dark:border-dark-200 bg-light-secondary/30 dark:bg-dark-secondary/30">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-sky-500/10 dark:bg-sky-500/10">
            <ProviderLogo
              providerKey={modelProvider.type}
              size={14}
              className="text-sky-500"
            />
          </div>
          <p className="text-sm lg:text-sm text-black dark:text-white font-medium">
            {modelProvider.name}
          </p>
        </div>
        <DeleteProvider
          modelProvider={modelProvider}
          setProviders={setProviders}
        />
      </div>
      <div className="flex flex-col gap-y-3 px-5 py-4">
        {errorMessage && (
          <div className="flex flex-row items-center gap-2 text-xs lg:text-xs text-red-500 dark:text-red-400 rounded-lg bg-red-50 dark:bg-red-950/20 px-3 py-2 border border-red-200 dark:border-red-900/30">
            <AlertCircle size={16} className="shrink-0" />
            <span className="break-words">{errorMessage}</span>
          </div>
        )}
        {isPublik && publik && (
          /* CONTRACT §12.2: the same primary button as the first-run card
             ("Pick a plan" while anonymous → claim_url; "Manage plan" once
             claimed → the dashboard) and the one-line "Why it costs money"
             disclosure. */
          <div className="flex flex-col gap-2">
            <BalanceLine status={publik} />
            <StatusLine status={publik} />
            <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 pt-1">
              <PlanCtaLink status={publik} surface="settings" />
            </div>
            <WhyItCosts />
          </div>
        )}
        {fields.length === 0 ? (
          <p className="text-xs text-black/50 dark:text-white/50">
            No configuration needed for this connection.
          </p>
        ) : (
          fields.map((field) => (
            <div key={field.key} className="flex flex-col items-start gap-1.5">
              <label className="text-xs text-black/70 dark:text-white/70">
                {field.name}
                {field.required && '*'}
              </label>
              <input
                value={config[field.key] ?? ''}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    [field.key]: event.target.value,
                  }))
                }
                className="w-full rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-4 py-3 text-[13px] text-black/80 dark:text-white/80 placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                placeholder={(field as StringUIConfigField).placeholder}
                type={field.type === 'password' ? 'password' : 'text'}
                required={field.required}
                readOnly={isPublik}
                disabled={isPublik}
              />
            </div>
          ))
        )}
        {isPublik && (
          <p className="text-[11px] text-black/40 dark:text-white/40">
            Managed by publik · issued to this computer. Remove the connection
            to use your own key instead.
          </p>
        )}
        {fields.length > 0 && !isPublik && (
          <div className="flex justify-end pt-1">
            <button
              onClick={handleSave}
              disabled={loading}
              className="px-4 py-2 rounded-lg text-[13px] bg-sky-500 text-white font-medium disabled:opacity-85 hover:opacity-85 active:scale-95 transition duration-200"
            >
              {loading ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                'Save'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModelProvider;
