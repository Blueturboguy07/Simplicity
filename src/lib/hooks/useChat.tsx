'use client';

import { Message } from '@/components/ChatWindow';
import { Block } from '@/lib/types';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import crypto from 'crypto';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { getSuggestions } from '../actions';
import { MinimalProvider } from '../models/types';
import { pickDefaultModel } from '../models/catalog';
import { getAutoMediaSearch } from '../config/clientRegistry';
import { applyPatch } from 'rfc6902';
import { Widget } from '@/components/ChatWindow';

export type Section = {
  message: Message;
  widgets: Widget[];
  parsedTextBlocks: string[];
  speechMessage: string;
  thinkingEnded: boolean;
  suggestions?: string[];
};

type ChatContext = {
  messages: Message[];
  sections: Section[];
  chatHistory: [string, string][];
  files: File[];
  fileIds: string[];
  sources: string[];
  chatId: string | undefined;
  optimizationMode: string;
  /* Composer's Search/Deep research/Model council pill — orthogonal to
     optimizationMode. Persisted to localStorage so a choice survives a
     reload, the same way the model and thinking toggles do. */
  searchMode: 'search' | 'deepResearch' | 'council';
  /* Perplexity ground truth: a lock toggle near the composer. Plain React
     state (never localStorage) so it's scoped to the CURRENT thread only —
     a new chat always starts with it off. When true, the client still
     streams the turn exactly as normal (blocks flow through SessionManager,
     not the db) but sends `incognito: true` so the server skips every
     chats/messages row write for this thread (route.ts + search/index.ts). */
  incognito: boolean;
  isMessagesLoaded: boolean;
  loading: boolean;
  notFound: boolean;
  messageAppeared: boolean;
  isReady: boolean;
  hasError: boolean;
  chatModelProvider: ChatModelProvider;
  embeddingModelProvider: EmbeddingModelProvider;
  researchEnded: boolean;
  setResearchEnded: (ended: boolean) => void;
  setOptimizationMode: (mode: string) => void;
  setSearchMode: (mode: 'search' | 'deepResearch' | 'council') => void;
  setSources: (sources: string[]) => void;
  setIncognito: (incognito: boolean) => void;
  setFiles: (files: File[]) => void;
  setFileIds: (fileIds: string[]) => void;
  sendMessage: (
    message: string,
    messageId?: string,
    rewrite?: boolean,
  ) => Promise<void>;
  stopGeneration: () => void;
  rewrite: (messageId: string) => void;
  setChatModelProvider: (provider: ChatModelProvider) => void;
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void;
};

export interface File {
  fileName: string;
  fileExtension: string;
  fileId: string;
}

interface ChatModelProvider {
  key: string;
  providerId: string;
}

interface EmbeddingModelProvider {
  key: string;
  providerId: string;
}

const checkConfig = async (
  setChatModelProvider: (provider: ChatModelProvider) => void,
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void,
  setIsConfigReady: (ready: boolean) => void,
  setHasError: (hasError: boolean) => void,
) => {
  try {
    let chatModelKey = localStorage.getItem('chatModelKey');
    let chatModelProviderId = localStorage.getItem('chatModelProviderId');
    let embeddingModelKey = localStorage.getItem('embeddingModelKey');
    let embeddingModelProviderId = localStorage.getItem(
      'embeddingModelProviderId',
    );

    const res = await fetch(`/api/providers`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(
        `Provider fetching failed with status code ${res.status}`,
      );
    }

    const data = await res.json();
    const providers: MinimalProvider[] = data.providers;

    if (providers.length === 0) {
      throw new Error(
        'No chat model providers found, please configure them in the settings page.',
      );
    }

    /* Honour a stored choice only if it still resolves to a real model —
       otherwise fall back to the curated catalog. Picking `chatModels[0]` (the
       old behaviour) selects whatever the provider's API happened to list
       first, which is how a Groq safety classifier or a retired gpt-3.5 ends
       up answering questions and hanging the request. */
    let chatModelProvider = providers.find((p) => p.id === chatModelProviderId);
    let resolvedChatKey = chatModelProvider?.chatModels.find(
      (m) => m.key === chatModelKey,
    )?.key;

    if (!chatModelProvider || !resolvedChatKey) {
      const fallback = pickDefaultModel(providers);
      if (!fallback) {
        throw new Error(
          'No chat models found, please configure them in the settings page.',
        );
      }
      chatModelProvider = providers.find((p) => p.id === fallback.providerId)!;
      resolvedChatKey = fallback.key;
    }

    chatModelProviderId = chatModelProvider.id;
    chatModelKey = resolvedChatKey;

    /* Embeddings only rerank search results, so this is never a user choice.
       Prefer a purpose-built embedding model — Ollama lists its chat models
       here too, and picking one of those means running every search result
       through a 7B chat model. */
    const embeddingModelProvider =
      providers.find((p) => p.id === embeddingModelProviderId) ??
      providers.find(
        (p) =>
          p.type === 'ollama' &&
          p.embeddingModels.some((m) => m.key.includes('embed')),
      ) ??
      providers.find((p) => p.embeddingModels.length > 0);

    if (!embeddingModelProvider) {
      throw new Error(
        'No embedding models found, pleae configure them in the settings page.',
      );
    }

    embeddingModelProviderId = embeddingModelProvider.id;

    /* Same reasoning as the provider choice above: prefer an actual embedding
       model over index 0, which for Ollama is a chat model. */
    const embeddingModel =
      embeddingModelProvider.embeddingModels.find(
        (m) => m.key === embeddingModelKey,
      ) ??
      embeddingModelProvider.embeddingModels.find((m) =>
        m.key.includes('embed'),
      ) ??
      embeddingModelProvider.embeddingModels[0];
    embeddingModelKey = embeddingModel.key;

    localStorage.setItem('chatModelKey', chatModelKey);
    localStorage.setItem('chatModelProviderId', chatModelProviderId);
    localStorage.setItem('embeddingModelKey', embeddingModelKey);
    localStorage.setItem('embeddingModelProviderId', embeddingModelProviderId);

    setChatModelProvider({
      key: chatModelKey,
      providerId: chatModelProviderId,
    });

    setEmbeddingModelProvider({
      key: embeddingModelKey,
      providerId: embeddingModelProviderId,
    });

    setIsConfigReady(true);
  } catch (err: any) {
    console.error('An error occurred while checking the configuration:', err);
    toast.error(err.message);
    setIsConfigReady(false);
    setHasError(true);
  }
};

const loadMessages = async (
  chatId: string,
  setMessages: (messages: Message[]) => void,
  setIsMessagesLoaded: (loaded: boolean) => void,
  chatHistory: React.MutableRefObject<[string, string][]>,
  setSources: (sources: string[]) => void,
  setNotFound: (notFound: boolean) => void,
  setFiles: (files: File[]) => void,
  setFileIds: (fileIds: string[]) => void,
) => {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 404) {
    setNotFound(true);
    setIsMessagesLoaded(true);
    return;
  }

  const data = await res.json();

  const messages = data.messages as Message[];

  setMessages(messages);

  const history: [string, string][] = [];
  messages.forEach((msg) => {
    history.push(['human', msg.query]);

    const textBlocks = msg.responseBlocks
      .filter(
        (block): block is Block & { type: 'text' } => block.type === 'text',
      )
      .map((block) => block.data)
      .join('\n');

    if (textBlocks) {
      history.push(['assistant', textBlocks]);
    }
  });

  console.debug(new Date(), 'app:messages_loaded');

  if (messages.length > 0) {
    document.title = messages[0].query;
  }

  const files = data.chat.files.map((file: any) => {
    return {
      fileName: file.name,
      fileExtension: file.name.split('.').pop(),
      fileId: file.fileId,
    };
  });

  setFiles(files);
  setFileIds(files.map((file: File) => file.fileId));

  chatHistory.current = history;
  setSources(data.chat.sources);
  setIsMessagesLoaded(true);
};

export const chatContext = createContext<ChatContext>({
  chatHistory: [],
  chatId: '',
  fileIds: [],
  files: [],
  sources: [],
  hasError: false,
  isMessagesLoaded: false,
  isReady: false,
  loading: false,
  messageAppeared: false,
  messages: [],
  sections: [],
  notFound: false,
  optimizationMode: '',
  searchMode: 'search',
  incognito: false,
  chatModelProvider: { key: '', providerId: '' },
  embeddingModelProvider: { key: '', providerId: '' },
  researchEnded: false,
  rewrite: () => {},
  sendMessage: async () => {},
  stopGeneration: () => {},
  setFileIds: () => {},
  setFiles: () => {},
  setSources: () => {},
  setIncognito: () => {},
  setOptimizationMode: () => {},
  setSearchMode: () => {},
  setChatModelProvider: () => {},
  setEmbeddingModelProvider: () => {},
  setResearchEnded: () => {},
});

export const ChatProvider = ({ children }: { children: React.ReactNode }) => {
  const params: { chatId: string } = useParams();

  const searchParams = useSearchParams();
  const initialMessage = searchParams.get('q');

  const [chatId, setChatId] = useState<string | undefined>(params.chatId);
  const [newChatCreated, setNewChatCreated] = useState(false);

  const [loading, setLoading] = useState(false);
  const [messageAppeared, setMessageAppeared] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [researchEnded, setResearchEnded] = useState(false);

  const chatHistory = useRef<[string, string][]>([]);
  const [messages, setMessages] = useState<Message[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  const [fileIds, setFileIds] = useState<string[]>([]);

  const [sources, setSources] = useState<string[]>(['web']);
  const [incognito, setIncognito] = useState(false);
  const [optimizationMode, setOptimizationMode] = useState('speed');
  const [searchMode, setSearchModeState] = useState<
    'search' | 'deepResearch' | 'council'
  >('search');

  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);

  const [notFound, setNotFound] = useState(false);

  const [chatModelProvider, setChatModelProvider] = useState<ChatModelProvider>(
    {
      key: '',
      providerId: '',
    },
  );

  const [embeddingModelProvider, setEmbeddingModelProvider] =
    useState<EmbeddingModelProvider>({
      key: '',
      providerId: '',
    });

  const [isConfigReady, setIsConfigReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const messagesRef = useRef<Message[]>([]);

  const sections = useMemo<Section[]>(() => {
    return messages.map((msg) => {
      const textBlocks: string[] = [];
      let speechMessage = '';
      let thinkingEnded = false;
      let suggestions: string[] = [];

      const sourceBlocks = msg.responseBlocks.filter(
        (block): block is Block & { type: 'source' } => block.type === 'source',
      );
      const sources = sourceBlocks.flatMap((block) => block.data);

      const widgetBlocks = msg.responseBlocks
        .filter((b) => b.type === 'widget')
        .map((b) => b.data) as Widget[];

      msg.responseBlocks.forEach((block) => {
        if (block.type === 'text') {
          let processedText = block.data;
          const citationRegex = /\[([^\]]+)\]/g;
          const regex = /\[(\d+)\]/g;

          if (processedText.includes('<think>')) {
            const openThinkTag = processedText.match(/<think>/g)?.length || 0;
            const closeThinkTag =
              processedText.match(/<\/think>/g)?.length || 0;

            if (openThinkTag && !closeThinkTag) {
              processedText += '</think> <a> </a>';
            }
          }

          if (block.data.includes('</think>')) {
            thinkingEnded = true;
          }

          if (sources.length > 0) {
            processedText = processedText.replace(
              citationRegex,
              (_, capturedContent: string) => {
                const numbers = capturedContent
                  .split(',')
                  .map((numStr) => numStr.trim());

                const linksHtml = numbers
                  .map((numStr) => {
                    const number = parseInt(numStr);

                    if (isNaN(number) || number <= 0) {
                      return `[${numStr}]`;
                    }

                    const source = sources[number - 1];
                    const url = source?.metadata?.url;

                    if (url) {
                      return `<citation href="${url}">${numStr}</citation>`;
                    } else {
                      return ``;
                    }
                  })
                  .join('');

                return linksHtml;
              },
            );
            speechMessage += block.data.replace(regex, '');
          } else {
            processedText = processedText.replace(regex, '');
            speechMessage += block.data.replace(regex, '');
          }

          textBlocks.push(processedText);
        } else if (block.type === 'suggestion') {
          suggestions = block.data;
        }
      });

      return {
        message: msg,
        parsedTextBlocks: textBlocks,
        speechMessage,
        thinkingEnded,
        suggestions,
        widgets: widgetBlocks,
      };
    });
  }, [messages]);

  const isReconnectingRef = useRef(false);
  const handledMessageEndRef = useRef<Set<string>>(new Set());

  const checkReconnect = async () => {
    if (isReconnectingRef.current) return;

    setIsReady(true);
    console.debug(new Date(), 'app:ready');

    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];

      if (lastMsg.status === 'answering') {
        setLoading(true);
        setResearchEnded(false);
        setMessageAppeared(false);

        isReconnectingRef.current = true;

        const res = await fetch(`/api/reconnect/${lastMsg.backendId}`, {
          method: 'POST',
        });

        if (!res.body) throw new Error('No response body');

        const reader = res.body?.getReader();
        const decoder = new TextDecoder('utf-8');

        let partialChunk = '';

        const messageHandler = getMessageHandler(lastMsg);

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            partialChunk += decoder.decode(value, { stream: true });

            try {
              const messages = partialChunk.split('\n');
              for (const msg of messages) {
                if (!msg.trim()) continue;
                const json = JSON.parse(msg);
                messageHandler(json);
              }
              partialChunk = '';
            } catch (error) {
              console.warn('Incomplete JSON, waiting for next chunk...');
            }
          }
        } finally {
          isReconnectingRef.current = false;
        }
      }
    }
  };

  useEffect(() => {
    checkConfig(
      setChatModelProvider,
      setEmbeddingModelProvider,
      setIsConfigReady,
      setHasError,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('searchMode');
    if (
      stored === 'search' ||
      stored === 'deepResearch' ||
      stored === 'council'
    ) {
      setSearchModeState(stored);
    }
  }, []);

  const setSearchMode = (mode: 'search' | 'deepResearch' | 'council') => {
    setSearchModeState(mode);
    localStorage.setItem('searchMode', mode);
  };

  useEffect(() => {
    if (params.chatId && params.chatId !== chatId) {
      setChatId(params.chatId);
      setMessages([]);
      chatHistory.current = [];
      setFiles([]);
      setFileIds([]);
      setIsMessagesLoaded(false);
      setNotFound(false);
      setNewChatCreated(false);
      /* Navigating to a different (already-persisted) chat — incognito is
         scoped to the thread that was active, never the one being switched
         to. */
      setIncognito(false);
    }
  }, [params.chatId, chatId]);

  useEffect(() => {
    if (
      chatId &&
      !newChatCreated &&
      !isMessagesLoaded &&
      messages.length === 0
    ) {
      loadMessages(
        chatId,
        setMessages,
        setIsMessagesLoaded,
        chatHistory,
        setSources,
        setNotFound,
        setFiles,
        setFileIds,
      );
    } else if (!chatId) {
      setNewChatCreated(true);
      setIsMessagesLoaded(true);
      setChatId(crypto.randomBytes(20).toString('hex'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isMessagesLoaded, newChatCreated, messages.length]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (isMessagesLoaded && isConfigReady && newChatCreated) {
      setIsReady(true);
      console.debug(new Date(), 'app:ready');
    } else if (isMessagesLoaded && isConfigReady && !newChatCreated) {
      checkReconnect();
    } else {
      setIsReady(false);
    }
  }, [isMessagesLoaded, isConfigReady, newChatCreated]);

  const rewrite = (messageId: string) => {
    const index = messages.findIndex((msg) => msg.messageId === messageId);

    if (index === -1) return;

    setMessages((prev) => prev.slice(0, index));

    chatHistory.current = chatHistory.current.slice(0, index * 2);

    const messageToRewrite = messages[index];
    sendMessage(messageToRewrite.query, messageToRewrite.messageId, true);
  };

  useEffect(() => {
    if (isReady && initialMessage && isConfigReady) {
      if (!isConfigReady) {
        toast.error('Cannot send message before the configuration is ready');
        return;
      }
      sendMessage(initialMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigReady, isReady, initialMessage]);

  const getMessageHandler = (message: Message) => {
    const messageId = message.messageId;

    return async (data: any) => {
      if (data.type === 'error') {
        const errorData =
          data.data && typeof data.data === 'object' && 'message' in data.data
            ? (data.data as {
                message: string;
                action?: { label: string; href: string };
              })
            : String(data.data ?? 'Something went wrong.');
        toast.error(
          typeof errorData === 'string' ? errorData : errorData.message,
        );
        setLoading(false);
        setResearchEnded(true);
        /* The toast vanishes in seconds — the turn itself must show the
           failure. An error block in responseBlocks survives on screen (and
           gives the Rewrite button an obvious retry target). */
        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? {
                  ...msg,
                  status: 'error' as const,
                  responseBlocks: [
                    ...msg.responseBlocks,
                    {
                      id: crypto.randomUUID(),
                      type: 'error',
                      data: errorData,
                    } as any,
                  ],
                }
              : msg,
          ),
        );
        return;
      }

      if (data.type === 'researchComplete') {
        setResearchEnded(true);
        if (
          message.responseBlocks.find(
            (b) => b.type === 'source' && b.data.length > 0,
          )
        ) {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'block') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const exists = msg.responseBlocks.findIndex(
                (b) => b.id === data.block.id,
              );

              if (exists !== -1) {
                const existingBlocks = [...msg.responseBlocks];
                existingBlocks[exists] = data.block;

                return {
                  ...msg,
                  responseBlocks: existingBlocks,
                };
              }

              return {
                ...msg,
                responseBlocks: [...msg.responseBlocks, data.block],
              };
            }
            return msg;
          }),
        );

        if (
          (data.block.type === 'source' && data.block.data.length > 0) ||
          data.block.type === 'text'
        ) {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'updateBlock') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const updatedBlocks = msg.responseBlocks.map((block) => {
                if (block.id === data.blockId) {
                  const updatedBlock = { ...block };
                  applyPatch(updatedBlock, data.patch);
                  return updatedBlock;
                }
                return block;
              });
              return { ...msg, responseBlocks: updatedBlocks };
            }
            return msg;
          }),
        );
      }

      if (data.type === 'messageEnd') {
        if (handledMessageEndRef.current.has(messageId)) {
          return;
        }

        handledMessageEndRef.current.add(messageId);

        const currentMsg = messagesRef.current.find(
          (msg) => msg.messageId === messageId,
        );

        const newHistory: [string, string][] = [
          ...chatHistory.current,
          ['human', message.query],
          [
            'assistant',
            currentMsg?.responseBlocks.find((b) => b.type === 'text')?.data ||
              '',
          ],
        ];

        chatHistory.current = newHistory;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? { ...msg, status: 'completed' as const }
              : msg,
          ),
        );

        setLoading(false);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];

        const autoMediaSearch = getAutoMediaSearch();

        if (autoMediaSearch) {
          setTimeout(() => {
            document
              .getElementById(`search-images-${lastMsg.messageId}`)
              ?.click();

            document
              .getElementById(`search-videos-${lastMsg.messageId}`)
              ?.click();
          }, 200);
        }

        // Check if there are sources and no suggestions

        const hasSourceBlocks = currentMsg?.responseBlocks.some(
          (block) => block.type === 'source' && block.data.length > 0,
        );
        const hasSuggestions = currentMsg?.responseBlocks.some(
          (block) => block.type === 'suggestion',
        );

        if (hasSourceBlocks && !hasSuggestions) {
          const suggestions = await getSuggestions(newHistory);
          const suggestionBlock: Block = {
            id: crypto.randomBytes(7).toString('hex'),
            type: 'suggestion',
            data: suggestions,
          };

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.messageId === messageId) {
                return {
                  ...msg,
                  responseBlocks: [...msg.responseBlocks, suggestionBlock],
                };
              }
              return msg;
            }),
          );
        }
      }
    };
  };

  const sendMessage: ChatContext['sendMessage'] = async (
    message,
    messageId,
    rewrite = false,
  ) => {
    if (loading || !message) return;
    setLoading(true);
    setResearchEnded(false);
    setMessageAppeared(false);

    const abortController = new AbortController();
    abortRef.current = abortController;

    if (messages.length <= 1) {
      window.history.replaceState(null, '', `/c/${chatId}`);
    }

    messageId = messageId ?? crypto.randomBytes(7).toString('hex');
    const backendId = crypto.randomBytes(20).toString('hex');

    const newMessage: Message = {
      messageId,
      chatId: chatId!,
      backendId,
      query: message,
      responseBlocks: [],
      status: 'answering',
      createdAt: new Date(),
    };

    setMessages((prevMessages) => [...prevMessages, newMessage]);

    const messageIndex = messages.findIndex((m) => m.messageId === messageId);

    const res = await fetch('/api/chat', {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: message,
        message: {
          messageId: messageId,
          chatId: chatId!,
          content: message,
        },
        chatId: chatId!,
        files: fileIds,
        sources: sources,
        optimizationMode: optimizationMode,
        searchMode: searchMode,
        incognito: incognito,
        history: rewrite
          ? chatHistory.current.slice(
              0,
              messageIndex === -1 ? undefined : messageIndex,
            )
          : chatHistory.current,
        chatModel: {
          key: chatModelProvider.key,
          providerId: chatModelProvider.providerId,
        },
        embeddingModel: {
          key: embeddingModelProvider.key,
          providerId: embeddingModelProvider.providerId,
        },
        systemInstructions: localStorage.getItem('systemInstructions'),
        thinking: localStorage.getItem('thinkingEnabled') !== '0',
      }),
    });

    /* A pre-flight rejection (invalid body, or Model council's server-side
       backstop when a stale client still has it selected with <2 connected
       models — see route.ts) comes back as a plain non-2xx JSON response,
       not the SSE stream. Surface it as a toast instead of hanging on a
       spinner forever waiting for stream events that will never arrive. */
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? 'That request failed. Try again.');
      setLoading(false);
      setMessages((prev) => prev.filter((msg) => msg.messageId !== messageId));
      return;
    }

    if (!res.body) throw new Error('No response body');

    const reader = res.body?.getReader();
    const decoder = new TextDecoder('utf-8');

    let partialChunk = '';

    const messageHandler = getMessageHandler(newMessage);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        partialChunk += decoder.decode(value, { stream: true });

        try {
          const messages = partialChunk.split('\n');
          for (const msg of messages) {
            if (!msg.trim()) continue;
            const json = JSON.parse(msg);
            messageHandler(json);
          }
          partialChunk = '';
        } catch (error) {
          console.warn('Incomplete JSON, waiting for next chunk...');
        }
      }
    } catch (err: any) {
      /* Stop button: the fetch abort surfaces here as an AbortError. Whatever
         streamed so far stays on screen; the turn just ends. */
      if (err?.name !== 'AbortError') throw err;
      setResearchEnded(true);
      setLoading(false);
    } finally {
      abortRef.current = null;
    }
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
  };

  return (
    <chatContext.Provider
      value={{
        messages,
        sections,
        chatHistory: chatHistory.current,
        files,
        fileIds,
        sources,
        chatId,
        hasError,
        isMessagesLoaded,
        isReady,
        loading,
        messageAppeared,
        notFound,
        optimizationMode,
        searchMode,
        incognito,
        stopGeneration,
        setFileIds,
        setFiles,
        setSources,
        setIncognito,
        setOptimizationMode,
        setSearchMode,
        rewrite,
        sendMessage,
        setChatModelProvider,
        chatModelProvider,
        embeddingModelProvider,
        setEmbeddingModelProvider,
        researchEnded,
        setResearchEnded,
      }}
    >
      {children}
    </chatContext.Provider>
  );
};

export const useChat = () => {
  const ctx = useContext(chatContext);
  return ctx;
};
