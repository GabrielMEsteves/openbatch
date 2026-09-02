import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AttachAddon } from '@xterm/addon-attach';
import '@xterm/xterm/css/xterm.css';

function TerminalComponent() {
  const terminalRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const token = localStorage.getItem('authToken');
    if (!token) {
      console.error("Token não encontrado. Faça login primeiro.");
      return;
    }

    // Usa a mesma origem do frontend. Em produção, o Nginx encaminha
    // /ws ao backend; em desenvolvimento, o Vite faz esse proxy.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Courier New', Courier, monospace",
      fontSize: 14,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
      },
      allowProposedApi: true 
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    
    const attachAddon = new AttachAddon(ws);

    term.loadAddon(fitAddon);
    term.loadAddon(attachAddon);

    term.open(terminalRef.current);

    const safeFit = () => {
      if (terminalRef.current && terminalRef.current.clientWidth > 0) {
        try {
          fitAddon.fit();
        } catch (e) {
        }
      }
    };

    requestAnimationFrame(() => {
      safeFit();
      setTimeout(safeFit, 250);
    });

    const resizeObserver = new ResizeObserver(() => {
       requestAnimationFrame(safeFit);
    });
    
    resizeObserver.observe(terminalRef.current);
    term.focus();

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      
      try {
        attachAddon.dispose();
        fitAddon.dispose();
        term.dispose();
      } catch(e) {}

      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    };
  }, []);

  return (
    <div className="terminal-wrapper">
      <div id="terminal-container" ref={terminalRef} />
    </div>
  );
}

export default TerminalComponent;
