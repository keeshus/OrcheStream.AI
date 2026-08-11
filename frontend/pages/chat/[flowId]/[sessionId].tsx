import { useRouter } from 'next/router';
import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { BrandLogo } from '@/components/BrandLogo';
import { TextField } from '@/components/ui/TextField';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function ChatPage() {
  const router = useRouter();
  const { flowId, sessionId } = router.query;
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load existing messages
  useEffect(() => {
    if (!sessionId) return;
    fetch(`${API_URL}/chat/sessions/${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.messages) setMessages(data.messages);
      })
      .catch(() => {});
  }, [sessionId]);

  // Focus the input when loading finishes
  useEffect(() => {
    if (!streaming) {
      inputRef.current?.focus();
    }
  }, [streaming, messages.length]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  useAssistantContext({ pageKey: 'chat:' + flowId, description: 'Chatting with an agent' });

  const sendMessage = async () => {
    if (!input.trim() || streaming || !sessionId) return;
    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: userMessage }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || `Request failed: ${res.status}`);
      }

      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (controller.signal.aborted) { reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === 'tool_call') {
                setMessages(prev => [...prev, { id: Date.now().toString() + Math.random(), role: 'assistant' as const, content: `🔧 Using ${event.data.name}...` }]);
              } else if (event.type === 'tool_result') {
                setMessages(prev => [...prev, { id: Date.now().toString() + Math.random(), role: 'assistant' as const, content: `✅ ${event.data.name} completed` }]);
              } else if (event.type === 'done') {
                setMessages(prev => [...prev, { id: event.data.messageId, role: 'assistant', content: event.data.content }]);
              } else if (event.type === 'error') {
                console.error('Chat error:', event.data.error);
                setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: `Error: ${event.data.error}` }]);
              }
            } catch {
              // Skip malformed frames
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };



  return (
    <div className="h-screen flex flex-col bg-surface">
      {/* Header */}
      <div className="h-12 border-b border-outline-variant flex items-center px-4 shrink-0 bg-surface-container">
          <Link href="/" className="flex items-center gap-1.5 mr-3 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <Link href={`/chat/${flowId}`} className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface mr-3">
            <Icon name="arrow_back" className="text-base" /> <span className="text-xs">Back</span>
        </Link>
        <h1 className="text-sm font-semibold text-on-surface">Chat</h1>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-4xl mx-auto space-y-4">
          {messages.length === 0 && !streaming && (
            <div className="text-center py-16">
              <Icon name="smart_toy" className="text-5xl text-outline-variant mx-auto mb-3" />
              <p className="text-on-surface-variant text-sm">Start a conversation with this agent</p>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                  msg.role === 'user' ? 'bg-primary' : 'bg-surface-container-high'
                }`}
              >
                {msg.role === 'user' ? (
                  <Icon name="person" className="text-base text-on-primary" />
                ) : (
                  <Icon name="smart_toy" className="text-base text-on-surface-variant" />
                )}
              </div>
              <div
                className={`max-w-[70%] rounded-lg px-4 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container-high text-on-surface'
                }`}
              >
                {msg.role === 'user' ? (
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                ) : (
                  <div className="prose prose-sm max-w-none [&_table]:text-left [&_th]:border [&_th]:border-outline [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-outline [&_td]:px-2 [&_td]:py-1">
                    <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
                <Icon name="sync" className="text-base text-on-surface-variant animate-spin" />
              </div>
              <div className="rounded-lg px-4 py-2 bg-surface-container-high">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-on-surface-variant rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-on-surface-variant rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-on-surface-variant rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-outline-variant bg-surface-container">
        <div className="max-w-4xl mx-auto p-4 flex gap-3">
          <TextField
            inputRef={inputRef}
            label="Message"
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            multiline
            rows={1}
            disabled={streaming}
            className="flex-1"
          />
          <button
            onClick={streaming ? stop : sendMessage}
            disabled={!streaming && !input.trim()}
            className="m3-button gap-2 shrink-0 self-end disabled:opacity-50 flex items-center"
          >
            {streaming ? <><Icon name="stop" className="text-base" /> Stop</> : <><Icon name="send" className="text-base" /> Send</>}
          </button>
        </div>
      </div>
    </div>
  );
}
