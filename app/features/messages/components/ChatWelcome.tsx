import './ChatWelcome.css';

export function ChatWelcome() {
  return (
    <section className="chatWelcome" aria-label="Welcome to Agents Chat">
      <div className="chatWelcomeMark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="M7 7h18v14H14l-7 5V7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 12h8M12 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <h2>Welcome to Agents Chat</h2>
      <p>Ask a question, share an idea, or start a task with your agents.</p>
      <ul className="chatWelcomeHints">
        <li>Type <kbd>/</kbd> for commands</li>
        <li>Use <kbd>@</kbd> to mention an agent</li>
      </ul>
    </section>
  );
}
