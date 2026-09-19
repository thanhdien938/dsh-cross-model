import React, { useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import './LoginTerminal.css';

interface LoginTerminalProps {
  product: string;
  mode: 'login' | 'logout';
  onClose: () => void;
}

// W3-A: a bounded, closed-command terminal view for one product's own
// native `login`/`logout` CLI flow only. It never lets the owner type an
// arbitrary command — the process was already spawned by main.ts with a
// fixed argv before this component even mounts; the only input surface
// here is stdin passthrough for answering the CLI's own prompts.
function LoginTerminal({ product, mode, onClose }: LoginTerminalProps) {
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(true);
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null; error?: string } | null>(null);
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLPreElement>(null);
  const requestClose = () => {
    if (!running) onClose();
  };
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose: requestClose, canClose: !running });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await window.desktop.loginTerminal.start({ product, mode });
      } catch (error: any) {
        if (!cancelled) {
          setRunning(false);
          setExitInfo({ code: null, signal: null, error: error?.message ?? 'LOGIN_TERMINAL_FAILED' });
        }
      }
    })();

    const unsubscribeData = window.desktop.loginTerminal.onData((chunk) => {
      setOutput((prev) => `${prev}${chunk}`);
    });
    const unsubscribeExit = window.desktop.loginTerminal.onExit((info) => {
      setRunning(false);
      setExitInfo(info);
    });

    return () => {
      cancelled = true;
      unsubscribeData();
      unsubscribeExit();
    };
  }, [product, mode]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [output]);

  const send = () => {
    if (!input) return;
    void window.desktop.loginTerminal.write(`${input}\n`);
    setInput('');
  };

  const stop = async () => {
    await window.desktop.loginTerminal.stop();
  };

  return (
    <div className="login-terminal-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-terminal-title"
        tabIndex={-1}
        className="login-terminal-dialog card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="login-terminal-header">
          <span id="login-terminal-title">
            {product} — {mode === 'login' ? 'Login' : 'Logout'}
          </span>
          <span className={`login-terminal-status ${running ? 'login-terminal-status-running' : ''}`}>
            {running ? 'RUNNING' : exitInfo?.error ? `FAILED (${exitInfo.error})` : `EXITED (code ${exitInfo?.code ?? 'unknown'})`}
          </span>
        </div>

        <pre ref={bodyRef} className="login-terminal-body">
          {output || 'Waiting for output…'}
        </pre>

        <div className="login-terminal-footer">
          <input
            className="login-terminal-input"
            placeholder="Type a response and press Send (e.g. to confirm a prompt)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            disabled={!running}
          />
          <button className="btn btn-secondary" onClick={send} disabled={!running}>
            Send
          </button>
          {running ? (
            <button className="btn btn-danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={requestClose}>
              Close
            </button>
          )}
        </div>

        <p className="login-terminal-note">
          This runs only the {product} CLI's own {mode} command. DSH never sees or stores your credentials.
        </p>
      </div>
    </div>
  );
}

export default LoginTerminal;
