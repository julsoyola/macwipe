(() => {
  "use strict";

  const numberFormat = new Intl.NumberFormat("en-US");
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const timestampNow = () => `[${timeFormat.format(new Date())}]`;
  const chatTemplate = document.createElement("template");
  // Fixed markup only. Questions, answers, and item names use textContent.
  chatTemplate.innerHTML = `
    <div class="chat-menu" aria-label="Messenger menu preview">
      File&nbsp;&nbsp; Edit&nbsp;&nbsp; Actions&nbsp;&nbsp; Help
    </div>
    <div class="chat-body">
      <aside class="chat-sidebar" aria-label="macwipe buddy">
        <div class="chat-avatar"><img class="pixel-icon" src="assets/mac-avatar.svg" width="32" height="32" alt="" /></div>
      </aside>
      <div class="chat-transcript" role="log" aria-label="Message history">
        <p><span class="message-time"></span> <strong class="sender-you">you:</strong> <span data-message="question"></span></p>
        <p><span class="message-time"></span> <strong class="sender-macwipe">macwipe:</strong> <span data-message="answer"></span></p>
      </div>
    </div>
    <div class="chat-toolbar" aria-label="Formatting preview">
      <span class="format-key">A</span>
      <span class="format-key"><i>I</i></span>
      <span class="format-key"><u>U</u></span>
    </div>
    <form class="chat-input-area" aria-label="Send a local message">
      <input type="text" placeholder="Type a question..." aria-label="Message" autocomplete="off">
      <button class="question-row" type="submit">Send</button>
    </form>
    <footer class="status-strip">Status: Connected · 100% local session</footer>
  `;

  function createChat(dialog) {
    dialog
      .querySelector("[data-chat-content]")
      .replaceChildren(chatTemplate.content.cloneNode(true));
    const question = dialog.querySelector('[data-message="question"]');
    const answer = dialog.querySelector('[data-message="answer"]');
    const timestamps = dialog.querySelectorAll(".message-time");
    const transcript = dialog.querySelector(".chat-transcript");
    const form = dialog.querySelector(".chat-input-area");
    const input = form.querySelector("input");
    const initialMessages = [...transcript.children];

    // One submit handler covers Send and Enter, with no network calls or timers.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      const entry = document.createElement("p");
      const time = document.createElement("span");
      time.className = "message-time";
      time.textContent = timestampNow();
      const sender = document.createElement("strong");
      sender.className = "sender-you";
      sender.textContent = "you:";
      const content = document.createElement("span");
      content.textContent = message;
      entry.append(time, " ", sender, " ", content);
      transcript.append(entry);
      input.value = "";
      input.focus();
      transcript.scrollTop = transcript.scrollHeight;
    });
    question.id = `${dialog.dataset.chatPrefix}-question`;
    answer.id = `${dialog.dataset.chatPrefix}-answer`;

    return (questionText, answerText) => {
      transcript.replaceChildren(...initialMessages);
      input.value = "";
      transcript.scrollTop = 0;
      question.textContent = questionText;
      answer.textContent = answerText;
      const timestamp = timestampNow();
      timestamps.forEach((time) => {
        time.textContent = timestamp;
      });
      if (!dialog.open) dialog.showModal();
    };
  }

  function isBackdrop(event, dialog) {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }

  // One set of handlers for every dialog; no listeners are added per opening.
  let pressedBackdrop = null;
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    pressedBackdrop =
      target instanceof HTMLDialogElement && isBackdrop(event, target)
        ? target
        : null;
  });
  document.addEventListener("pointercancel", () => {
    pressedBackdrop = null;
  });
  document.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close]");
    if (close) close.closest("dialog").close();
    else if (pressedBackdrop && isBackdrop(event, pressedBackdrop))
      pressedBackdrop.close();
    pressedBackdrop = null;
  });

  window.MacwipeUI = Object.freeze({
    createChat,
    formatMB: (amount) => `${numberFormat.format(amount)} MB`,
  });
})();
