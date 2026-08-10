import {
  ConfigModelProvider,
  ModelProviderUISection,
  StringUIConfigField,
  UIConfigField,
} from '@/lib/config/types';
import ProviderLogo from '@/components/ui/ProviderLogo';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Info,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/* What each provider costs and what it needs, in plain language.
 *
 * This is written for someone who has never heard of any of these — the whole
 * point of the list is that you can see at a glance which options are free
 * before you're asked for anything. Free here means "no payment to use it",
 * which for the local runtimes is literal: they run on your own machine.
 */
const providerInfo: Record<string, { free: boolean; blurb: string }> = {
  ollama: {
    free: true,
    blurb:
      'Free — runs on your computer. No account, no key, nothing to pay.',
  },
  anthropic: {
    free: false,
    blurb: 'Paste a key from console.anthropic.com, or use your Claude plan.',
  },
  lemonade: {
    free: true,
    blurb: 'Connects to a Lemonade server you run.',
  },
  gemini: {
    free: false,
    blurb: 'Key from Google AI Studio. Has a free tier.',
  },
  groq: {
    free: false,
    blurb: 'Key from console.groq.com. Has a free tier.',
  },
  openai: { free: false, blurb: 'Paid key from platform.openai.com.' },
};

/* Where to actually go get a key, for the providers that need one. Opened in
   a new tab from the row itself so nobody has to go hunting for the right
   console page. */
const keyLinks: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  groq: 'https://console.groq.com/keys',
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

/* The only thing we ever ask for is the key. Anything else the provider needs
   (base URLs, mostly) has a sensible default or placeholder, so we fill it in
   rather than putting another box in front of the user. */
const keyField = (fields: UIConfigField[]) =>
  fields.find((f) => f.type === 'password');

const autoConfig = (fields: UIConfigField[]) => {
  const config: Record<string, any> = {};
  fields.forEach((field) => {
    if (field.type === 'password') return;
    config[field.key] =
      field.default ?? (field as StringUIConfigField).placeholder ?? '';
  });
  return config;
};

const ProviderRow = ({
  provider,
  connected,
  setProviders,
}: {
  provider: ModelProviderUISection;
  connected: boolean;
  setProviders: React.Dispatch<React.SetStateAction<ConfigModelProvider[]>>;
}) => {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [tier, setTier] = useState('balanced');
  const [progress, setProgress] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  /* Install failures also go through toast.error below, but a toast alone
     isn't loud enough here: it auto-dismisses in a few seconds, and if it
     fires while the setup wizard's entrance animation is mid-transition it
     can be missed entirely. This is the "click Install, it spins for a
     second, and silently goes back to the button" bug — the fix is a message
     that stays on screen until the user retries or dismisses it, not a toast
     that can pass by unread. */
  const [installError, setInstallError] = useState<string | null>(null);

  const info = providerInfo[provider.key];
  const field = keyField(provider.fields as UIConfigField[]);

  /* Ollama is the one provider we can set up end to end: download the engine,
     start it, and pull a model. The response is a progress stream because that
     work is minutes long — a bare spinner would look hung. */
  const install = async () => {
    setLoading(true);
    setInstallError(null);
    setProgress('Starting…');
    try {
      const res = await fetch('/api/local-runtime/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok || !res.body) throw new Error('Setup failed');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);

          if (ev.phase === 'error') throw new Error(ev.message);
          if (ev.phase === 'done') {
            setProviders((prev) => [...prev, ev.provider]);
            toast.success('Local AI is ready.');
            continue;
          }
          setProgress(ev.message);
          setPercent(typeof ev.percent === 'number' ? ev.percent : null);
        }
      }
    } catch (err: any) {
      const message = err?.message ?? "Couldn't set up local AI.";
      setInstallError(message);
      toast.error(message);
    } finally {
      setLoading(false);
      setProgress(null);
      setPercent(null);
    }
  };

  /* The server saves a provider even when its credentials are rejected: it
     catches the failed model fetch and hands back a sentinel model named
     `error` with HTTP 200 (see ModelRegistry.addProvider). Taking that at face
     value is how a typo'd key ends up showing "Connected". So: inspect the
     returned models, and if the credential didn't work, delete the provider
     again and surface the real reason. */
  const register = async (
    type: string,
    name: string,
    config: Record<string, any>,
  ) => {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name, config }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message || 'Failed to connect');

    const added: ConfigModelProvider = body.provider;
    const failure = added?.chatModels?.find((m) => m.key === 'error');

    if (failure) {
      await fetch(`/api/providers/${added.id}`, { method: 'DELETE' }).catch(
        () => {
          /* rollback is best-effort — the error below is what matters */
        },
      );
      throw new Error(failure.name || 'Those credentials were rejected.');
    }

    return added;
  };

  const connect = async () => {
    if (field?.required && !key.trim()) return;
    setLoading(true);
    try {
      const added = await register(provider.key, provider.name, {
        ...autoConfig(provider.fields as UIConfigField[]),
        ...(field ? { [field.key]: key.trim() } : {}),
      });
      setProviders((prev) => [...prev, added]);
      setKey('');
      toast.success(`${provider.name} connected.`);
    } catch (err: any) {
      toast.error(err?.message ?? `Couldn't connect ${provider.name}.`);
    } finally {
      setLoading(false);
    }
  };

  /* Anthropic's second path: use the Claude Code install the user already has,
     so their Claude plan answers queries and there's no key to paste. Same row,
     different provider underneath. */
  const connectAccount = async () => {
    setLoading(true);
    setProgress('Checking Claude Code…');
    try {
      /* Verify before registering. The provider's model list is static, so it
         would happily "connect" against a signed-out CLI and only fail on the
         first real search — this runs one trivial prompt to prove it works. */
      const check = await fetch('/api/local-runtime/claude', { method: 'POST' });
      const checkBody = await check.json().catch(() => ({}));
      if (!check.ok) throw new Error(checkBody?.message);

      const added = await register('claudecode', 'Claude (your account)', {
        binary: '',
      });
      setProviders((prev) => [...prev, added]);
      toast.success('Connected to your Claude account.');
    } catch (err: any) {
      toast.error(
        err?.message ??
          'Claude Code was not found. Install it and sign in, then try again.',
      );
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-3 md:px-4 py-3',
        connected
          ? 'border-[#24A0ED]/40 bg-[#24A0ED]/5'
          : 'border-light-200 dark:border-dark-200 bg-light-secondary/30 dark:bg-dark-secondary/30',
      )}
    >
      <div className="flex flex-row items-center gap-3 md:gap-4">
      <ProviderLogo
        providerKey={provider.key}
        size={24}
        className="text-black/80 dark:text-white/80 shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-row items-center gap-2">
          <p className="text-xs sm:text-sm font-medium text-black dark:text-white truncate">
            {provider.name}
          </p>
          {info && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                info.free
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-black/5 dark:bg-white/10 text-black/50 dark:text-white/50',
              )}
            >
              {info.free ? 'Free' : 'API key'}
            </span>
          )}
        </div>
        <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5 truncate">
          {info?.blurb ?? ''}
        </p>
      </div>

      {connected ? (
        <span className="flex shrink-0 flex-row items-center gap-1.5 text-xs font-medium text-[#24A0ED]">
          <Check className="h-4 w-4" strokeWidth={2.5} />
          Connected
        </span>
      ) : progress ? (
        /* Live install progress — the model download is the long pole, so the
           percentage is worth showing rather than a spinner. */
        <div className="flex shrink-0 flex-col items-end gap-1 w-40 sm:w-56">
          <p className="text-[10px] text-black/60 dark:text-white/60 truncate w-full text-right">
            {progress}
          </p>
          <div className="h-1 w-full rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
            <div
              className="h-full rounded-full bg-[#24A0ED] transition-all duration-300"
              style={{ width: `${percent ?? 8}%` }}
            />
          </div>
        </div>
      ) : provider.key === 'ollama' ? (
        <div className="flex shrink-0 flex-row items-center gap-2">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-2 py-1.5 text-xs text-black/80 dark:text-white/80 focus-visible:outline-none"
          >
            <option value="fast">Fast · ~2 GB</option>
            <option value="balanced">Balanced · ~4.7 GB</option>
            <option value="quality">Best · ~9 GB</option>
          </select>
          <button
            type="button"
            onClick={install}
            disabled={loading}
            className="rounded-lg bg-[#24A0ED] px-3 py-1.5 text-xs font-medium text-white transition duration-200 hover:bg-[#1e8fd1] active:scale-95 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Install'}
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex flex-row items-center gap-2">
            {field && (
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connect()}
                type="password"
                placeholder="Paste API key"
                className="w-28 sm:w-40 rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-3 py-1.5 text-xs text-black/80 dark:text-white/80 placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300 transition-colors"
              />
            )}
            <button
              type="button"
              onClick={connect}
              disabled={loading || (field?.required && !key.trim())}
              className="rounded-lg bg-[#24A0ED] px-3 py-1.5 text-xs font-medium text-white transition duration-200 hover:bg-[#1e8fd1] active:scale-95 disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:active:scale-100"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                'Connect'
              )}
            </button>

            {/* Anthropic is the one provider with two ways in — a key, or the
                Claude plan the user already pays for. Both live on this row. */}
            {provider.key === 'anthropic' && (
              <>
                <span className="text-[10px] text-black/30 dark:text-white/30">
                  or
                </span>
                <button
                  type="button"
                  onClick={connectAccount}
                  disabled={loading}
                  className="rounded-lg border border-light-200 dark:border-dark-200 px-3 py-1.5 text-xs font-medium text-black/80 dark:text-white/80 transition duration-200 hover:bg-light-secondary dark:hover:bg-dark-secondary active:scale-95 disabled:opacity-60"
                >
                  Connect account
                </button>
              </>
            )}
          </div>
          {keyLinks[provider.key] && (
            <a
              href={keyLinks[provider.key]}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-row items-center gap-0.5 text-[9px] sm:text-[10px] text-black/40 dark:text-white/40 hover:text-[#24A0ED] hover:dark:text-[#24A0ED] transition-colors"
            >
              Get a key
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      )}
      </div>

      {/* Stays up until the next attempt (see install()'s setInstallError(null))
          or it's dismissed — a toast alone can pass by unread, and reverting
          straight to the bare "Install" button with no trace of what happened
          is the exact bug this fixes: a failed install looked identical to a
          button that silently did nothing. */}
      {installError && (
        <div className="flex flex-row items-start gap-2 text-[11px] sm:text-xs text-red-500 dark:text-red-400 rounded-lg bg-red-50 dark:bg-red-950/20 px-3 py-2 border border-red-200 dark:border-red-900/30">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span className="break-words flex-1">{installError}</span>
          <button
            type="button"
            onClick={() => setInstallError(null)}
            aria-label="Dismiss"
            className="shrink-0 text-red-500/60 hover:text-red-500 dark:text-red-400/60 dark:hover:text-red-400 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

/* A first-timer's first question, answered before they're asked for anything.
 * Collapses to a small toggle rather than disappearing outright, so it can be
 * brought back if someone dismisses it and then wants it again. */
const ApiKeyExplainer = () => {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 flex flex-row items-center gap-1.5 text-xs font-medium text-[#24A0ED] hover:underline"
      >
        <Info className="h-3.5 w-3.5" />
        What&apos;s an API key?
      </button>
    );
  }

  return (
    <div className="mb-3 flex flex-col gap-1.5 rounded-xl border border-[#24A0ED]/30 bg-[#24A0ED]/5 px-3.5 py-3">
      <div className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-row items-center gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 text-[#24A0ED]" />
          <p className="text-xs sm:text-sm font-medium text-black dark:text-white">
            What&apos;s an API key?
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-0.5 text-black/40 dark:text-white/40 hover:text-black/70 hover:dark:text-white/70 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60">
        Think of it like a password — it lets Simplicity use an AI service
        (like OpenAI or Google) under your own account, so usage is billed to
        you, not us. Keys stay on your device and go straight to that
        provider, never anywhere else. Would rather skip that? Ollama (installs
        on your computer) and Claude through your existing subscription both
        work with no key at all.
      </p>
      <p className="text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60">
        <span className="font-medium text-black/80 dark:text-white/80">
          One key unlocks every model that provider offers
        </span>{' '}
        — add an OpenAI key and GPT-5.1 and GPT-5 mini both appear in the
        chat&apos;s model dropdown; an xAI key adds Grok; and so on. Nothing is
        locked behind a plan.
      </p>
      <p className="text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60">
        <span className="font-medium text-black/80 dark:text-white/80">
          Getting a key takes ~2 minutes:
        </span>{' '}
        use the &quot;Get a key&quot; link on a provider below → sign in (or
        create a free developer account) → add a small credit balance if the
        platform asks (usually $5 minimum; each answer costs fractions of a
        cent and Simplicity shows the exact price under every answer) → click
        &quot;Create key&quot; → copy it → paste it here.
      </p>
    </div>
  );
};

/* Onboarding's provider step.
 *
 * The generic "Add Connection" button hid every provider behind a dropdown, so
 * a new user had no idea what was on offer or what it would cost. This lists
 * them outright — free options included — and asks for nothing beyond a key.
 */
const ProviderPicker = ({
  modelProviders,
  providers,
  setProviders,
}: {
  modelProviders: ModelProviderUISection[];
  providers: ConfigModelProvider[];
  setProviders: React.Dispatch<React.SetStateAction<ConfigModelProvider[]>>;
}) => {
  const connectedTypes = new Set(providers.map((p) => p.type));

  /* Hidden from the list, for different reasons:
     - transformers is embeddings-only with no configuration, so it can't
       satisfy this step (which needs a chat model) and has nothing to ask for.
     - claudecode isn't a separate choice for the user — it's the "connect
       account" half of the Anthropic row, so it would be a confusing duplicate
       of a provider they've already seen. */
  const offered = modelProviders.filter(
    (p) =>
      p.key !== 'transformers' &&
      p.key !== 'claudecode' &&
      /* Niche self-hosted server with no model catalog entries — a dead-end
         row for the audience this screen is written for. */
      p.key !== 'lemonade',
  );

  /* Anthropic counts as connected whichever way in they used. */
  const isConnected = (key: string) =>
    connectedTypes.has(key) ||
    (key === 'anthropic' && connectedTypes.has('claudecode'));

  /* Free options first — someone who doesn't want to pay should see those
     before they see a row asking for a credit-card-backed key. */
  const ordered = [...offered].sort(
    (a, b) =>
      Number(providerInfo[b.key]?.free ?? false) -
      Number(providerInfo[a.key]?.free ?? false),
  );

  return (
    <div className="flex flex-col">
      <ApiKeyExplainer />
      <div className="flex flex-col gap-2">
        {ordered.map((provider) => (
          <ProviderRow
            key={provider.key}
            provider={provider}
            connected={isConnected(provider.key)}
            setProviders={setProviders}
          />
        ))}
      </div>
      <p className="mt-3 flex flex-row items-center gap-1.5 text-[10px] sm:text-xs text-black/40 dark:text-white/40">
        <Sparkles className="h-3 w-3 shrink-0" />
        Once connected, pick a model from the dropdown in the chat box — free
        options are labeled.
      </p>
    </div>
  );
};

export default ProviderPicker;
