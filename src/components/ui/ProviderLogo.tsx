import {
  IconType,
  SiAnthropic,
  SiClaude,
  SiGooglegemini,
  SiHuggingface,
  SiOllama,
  SiOpenai,
} from '@icons-pack/react-simple-icons';
import { cn } from '@/lib/utils';

/* Marks for the providers we accept. simple-icons doesn't publish one for Groq,
   LM Studio or Lemonade, so those fall back to a lettermark rather than a
   made-up logo. Everything renders in currentColor so it reads correctly in
   both themes without per-brand colour handling. */
const brands: Record<string, { icon?: IconType; letters?: string }> = {
  openai: { icon: SiOpenai },
  anthropic: { icon: SiAnthropic },
  gemini: { icon: SiGooglegemini },
  ollama: { icon: SiOllama },
  transformers: { icon: SiHuggingface },
  claudecode: { icon: SiClaude },
  groq: { letters: 'G' },
  lemonade: { letters: 'L' },
  xai: { letters: 'X' },
  /* No vendor mark, no invented logo — same lettermark fallback as groq. */
  publik: { letters: 'pk' },
  openaicompatible: { letters: 'OC' },
};

const ProviderLogo = ({
  providerKey,
  size = 22,
  className,
}: {
  providerKey: string;
  size?: number;
  className?: string;
}) => {
  const brand = brands[providerKey];

  if (brand?.icon) {
    const Icon = brand.icon;
    return <Icon size={size} className={className} />;
  }

  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-current/25 font-semibold leading-none tracking-tight',
        className,
      )}
    >
      {brand?.letters ?? providerKey.slice(0, 2).toUpperCase()}
    </span>
  );
};

export default ProviderLogo;
