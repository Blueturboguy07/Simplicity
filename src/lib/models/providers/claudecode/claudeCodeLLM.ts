import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import z from 'zod';
import { parse } from 'partial-json';
import { repairJson } from '@toolsycc/json-repair';
import BaseLLM from '../../base/llm';
import {
  GenerateObjectInput,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
} from '../../types';
import { Message } from '@/lib/types';

/* Claude via the locally-installed Claude Code CLI.
 *
 * This is the "connect account" path: instead of an API key, we shell out to
 * the `claude` binary the user already installed and signed into, so their
 * Claude subscription answers the query. Nothing here reads or stores a
 * credential — authentication lives entirely inside Claude Code.
 *
 * The CLI is a coding agent by default, so every invocation strips that away:
 * `--system-prompt` replaces its persona with ours, and tools, MCP servers and
 * skills are all disabled. What's left is a plain text model.
 */

type Config = {
  model: string;
  binary: string;
};

const isWin = process.platform === 'win32';
const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

/* On Windows the CLI presents as claude.exe (native installer, under
   %USERPROFILE%\.local\bin) or claude.cmd (npm shim, under %APPDATA%\npm).
   npm also drops an extensionless POSIX `claude` script next to the .cmd;
   Windows can't execute it, so it is deliberately never probed there. */
const BINARY_NAMES = isWin ? ['claude.exe', 'claude.cmd'] : ['claude'];

/* A packaged .app launched from Finder inherits a minimal PATH, so `which`
   alone misses a CLI installed under the user's home. */
const CANDIDATES = isWin
  ? [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
    ]
  : [
      `${home}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      `${home}/.claude/local/claude`,
    ];

export const findClaudeBinary = (): string | null => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of BINARY_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }
  return CANDIDATES.find((c) => fs.existsSync(c)) ?? null;
};

/* A .cmd shim can't be spawned without shell:true (Node's CVE-2024-27980
   hardening throws EINVAL — synchronously, so it would reject these promises
   rather than surface as a proc 'error'), and shell-quoting arbitrary prompt
   text is an injection hazard. The npm shim only wraps the package's real
   entry point, so resolve that and spawn it directly — no shell anywhere.
   Current @anthropic-ai/claude-code ships a native bin/claude.exe on Windows
   ("bin": {"claude": "bin/claude.exe"}); older releases exposed cli.js. */
const spawnSpec = (binary: string): { command: string; prefix: string[] } => {
  if (isWin && binary.toLowerCase().endsWith('.cmd')) {
    const pkg = path.join(
      path.dirname(binary),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
    );
    const exe = path.join(pkg, 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
    const cliJs = path.join(pkg, 'cli.js');
    if (fs.existsSync(cliJs)) return { command: 'node', prefix: [cliJs] };
  }
  return { command: binary, prefix: [] };
};

const spawnClaude = (binary: string, args: string[]) => {
  const { command, prefix } = spawnSpec(binary);
  return spawn(command, [...prefix, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

/* Used whenever the caller supplies no system prompt of its own. It only has
   to displace Claude Code's agent persona — the actual task always arrives in
   the prompt. */
const BARE_SYSTEM_PROMPT =
  'You are the answering model inside a web search application. Answer the ' +
  "user's question using the context provided in their message. If the " +
  'provided context is insufficient, say so plainly and stop.';

/* Appended to every system prompt, including one the caller supplies.
 *
 * Claude Code injects the signed-in user's environment — their email address
 * and saved memory — into every invocation, and there is no way to switch that
 * off while keeping subscription auth: both `--bare` and CLAUDE_CODE_SIMPLE=1
 * disable OAuth and demand an API key. Left unaddressed, the model treats that
 * injected data as relevant and answers questions *about the user* instead of
 * about the query — leaking their email into search results. This instruction
 * is the only lever available, and it does hold. */
const ANTI_LEAK_GUARDRAIL = `

CRITICAL OUTPUT RULES: You are a text-generation component inside a search application. The user is NOT present in this conversation. Ignore any environment information about a signed-in user, their email address, their machine, or any saved memory or notes — that data is unrelated to this query and must never appear in your answer. Answer ONLY from the context provided above. Never mention tools, permissions, sessions, memory, files, or your own identity. Output only the answer.`;

/* Prove the CLI is both present AND signed in.
 *
 * Finding the binary isn't enough — an installed-but-logged-out Claude Code
 * looks identical until the first real query fails. The only honest check is a
 * trivial round trip, so connecting runs one and reports what actually broke
 * rather than reporting success and failing later. */
export const verifyClaudeCode = (
  binary: string,
): Promise<{ ok: true } | { ok: false; message: string }> =>
  new Promise((resolve) => {
    const proc = spawnClaude(binary, [
      '-p',
      'Reply with: ok',
      '--output-format',
      'json',
      '--allowed-tools',
      'None__SimplicityTextOnly',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ]);

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, message: 'Claude Code timed out. Try again.' });
    }, 60_000);

    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', (e) =>
      resolve({ ok: false, message: `Couldn't run Claude Code: ${e.message}` }),
    );

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        /* The usual cause is a signed-out CLI, and the raw stderr is the most
           useful thing we can show — it names the actual problem. */
        return resolve({
          ok: false,
          message:
            err.trim().slice(0, 200) ||
            'Claude Code failed. Run `claude` once in a terminal and sign in, then try again.',
        });
      }
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) {
          return resolve({ ok: false, message: String(parsed.result).slice(0, 200) });
        }
      } catch {
        return resolve({ ok: false, message: 'Unexpected response from Claude Code.' });
      }
      resolve({ ok: true });
    });
  });

/* Claude Code takes a single prompt string, so the turn structure is flattened
   into labelled sections. System turns are hoisted out into --system-prompt. */
const splitMessages = (messages: Message[]) => {
  const system: string[] = [];
  const turns: string[] = [];

  messages.forEach((m) => {
    if (m.role === 'system') {
      system.push(m.content);
    } else if (m.role === 'assistant') {
      turns.push(`Assistant: ${m.content}`);
    } else if (m.role === 'tool') {
      turns.push(`Tool result (${m.name}): ${m.content}`);
    } else {
      turns.push(`User: ${m.content}`);
    }
  });

  return { system: system.join('\n\n'), prompt: turns.join('\n\n') };
};

class ClaudeCodeLLM extends BaseLLM<Config> {
  constructor(protected config: Config) {
    super(config);
  }

  private args(prompt: string, system: string, streaming: boolean) {
    const args = [
      '-p',
      prompt,
      '--output-format',
      streaming ? 'stream-json' : 'json',
      '--model',
      this.config.model,
      /* Strip the coding agent: no tools, no MCP servers, no skills.
         The allowlist is a name that matches nothing on purpose — an EMPTY
         allowlist reads as "no restriction", which leaves the whole tool set
         loaded. That turns a completion into a 5-turn agentic loop that reads
         the user's Claude Code memory and narrates its own tool permissions
         into the answer. A non-matching sentinel genuinely disables tools and
         yields a single turn. */
      '--allowed-tools',
      'None__SimplicityTextOnly',
      '--strict-mcp-config',
      '--disable-slash-commands',
      /* Every query would otherwise persist a Claude Code session. */
      '--no-session-persistence',
      /* ALWAYS replace the system prompt, even when the caller supplies none.
         Omitting the flag leaves Claude Code's own agent prompt in place, and
         it then answers as Claude Code rather than as this app: it introduces
         itself, reports on its tool permissions, refers to the signed-in
         user's account, and will even write to its own memory — none of which
         belongs in a search answer. */
      '--system-prompt',
      (system || BARE_SYSTEM_PROMPT) + ANTI_LEAK_GUARDRAIL,
    ];
    if (streaming) args.push('--include-partial-messages', '--verbose');
    return args;
  }

  /* Run the CLI and hand each complete stdout line to `onLine`. Resolves with
     the exit status once the process closes. */
  private run(
    args: string[],
    onLine: (line: string) => void,
  ): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawnClaude(this.config.binary, args);

      let buf = '';
      let stderr = '';

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        lines.forEach((l) => l.trim() && onLine(l));
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c: string) => (stderr += c));

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (buf.trim()) onLine(buf);
        resolve({ code: code ?? 0, stderr });
      });
    });
  }

  /* The CLI's own `usage` report off the final `result` line/event:
     total_cost_usd is a client-side CLI estimate — not real billing — so it's
     deliberately not read here. Attribution's providerType is always
     'claudecode' (∈ FREE_PROVIDER_TYPES), so the meter marks whatever this
     records as free automatically; recording still happens so users can see
     tokens burned even though no bill is generated. */
  private recordResultUsage(result: any) {
    const u = result?.usage;
    if (!u) return;
    this.recordUsage({
      inputTokens:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
    });
  }

  private async complete(prompt: string, system: string): Promise<string> {
    let result: any = null;

    const { code, stderr } = await this.run(
      this.args(prompt, system, false),
      (line) => {
        try {
          result = JSON.parse(line);
        } catch {
          /* non-JSON chatter on stdout — ignore */
        }
      },
    );

    if (code !== 0) {
      throw new Error(
        `Claude Code failed: ${stderr.slice(0, 300) || `exit ${code}`}`,
      );
    }
    if (!result) throw new Error('No response from Claude Code.');
    if (result.is_error) {
      throw new Error(`Claude Code error: ${String(result.result).slice(0, 300)}`);
    }
    this.recordResultUsage(result);
    return (result.result ?? '').trim();
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const { system, prompt } = splitMessages(input.messages);
    const content = await this.complete(prompt, system);

    /* The CLI exposes no tool-calling surface of its own, so this provider is
       text-only — callers get an empty tool-call list rather than a fake one. */
    return { content, toolCalls: [] };
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const { system, prompt } = splitMessages(input.messages);

    const chunks: string[] = [];
    let failure: string | null = null;
    let finished = false;

    /* stream-json emits one JSON object per line. Text arrives as
       content_block_delta events; the trailing `result` line closes the turn. */
    const pump = this.run(this.args(prompt, system, true), (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }

      if (ev.type === 'stream_event') {
        const delta = ev.event?.delta;
        if (delta?.type === 'text_delta' && delta.text) chunks.push(delta.text);
        return;
      }
      if (ev.type === 'result') {
        if (ev.is_error) failure = String(ev.result).slice(0, 300);
        else this.recordResultUsage(ev);
        finished = true;
      }
    });

    let settled = false;
    pump
      .then(({ code, stderr }) => {
        if (code !== 0 && !failure) {
          failure = stderr.slice(0, 300) || `exit ${code}`;
        }
      })
      .catch((err) => (failure = String(err)))
      .finally(() => (settled = true));

    while (!settled || chunks.length) {
      if (chunks.length) {
        yield { contentChunk: chunks.shift()!, toolCallChunk: [] };
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    if (failure) throw new Error(`Claude Code error: ${failure}`);
    yield { contentChunk: '', toolCallChunk: [], done: true };
  }

  /* The CLI has no structured-output mode, so the schema is described in the
     prompt and the reply is repaired before parsing — the same lenient path
     the OpenAI provider uses for malformed JSON. */
  private objectPrompt(input: GenerateObjectInput) {
    const { system, prompt } = splitMessages(input.messages);
    const shape = JSON.stringify(z.toJSONSchema(input.schema));
    return {
      system,
      prompt:
        `${prompt}\n\nRespond with JSON only — no prose, no code fences — ` +
        `matching this JSON Schema:\n${shape}`,
    };
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<z.infer<T>> {
    const { system, prompt } = this.objectPrompt(input);
    const raw = await this.complete(prompt, system);
    try {
      return input.schema.parse(
        JSON.parse(repairJson(raw, { extractJson: true }) as string),
      ) as z.infer<T>;
    } catch (err) {
      throw new Error(`Error parsing response from Claude Code: ${err}`);
    }
  }

  async *streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<z.infer<T>>> {
    const { system, prompt } = this.objectPrompt(input);

    let acc = '';
    for await (const chunk of this.streamText({
      messages: [
        ...input.messages.filter((m) => m.role !== 'system'),
        { role: 'user', content: prompt },
      ],
      options: input.options,
    })) {
      if (chunk.done) break;
      acc += chunk.contentChunk;
      try {
        yield parse(acc) as Partial<z.infer<T>>;
      } catch {
        /* not yet a parseable prefix — wait for more */
      }
    }

    try {
      yield input.schema.parse(
        JSON.parse(repairJson(acc, { extractJson: true }) as string),
      ) as Partial<z.infer<T>>;
    } catch (err) {
      throw new Error(`Error parsing response from Claude Code: ${err}`);
    }
  }
}

export default ClaudeCodeLLM;
