(() => {
  "use strict";

  const questions = {
    data: {
      question: "what happens with my data?",
      answer:
        "Nothing ever leaves your Mac. Everything processes 100% locally in your browser or local app environment without external servers or network requests.",
    },
    local: {
      question: "does it only scan my own Mac?",
      answer:
        "Yes. It only scans local directories on your computer that you explicitly choose to review.",
    },
    safe: {
      question: "is it safe to delete these files?",
      answer:
        "Yes. macwipe focuses on temporary caches, stale downloads, and unneeded junk, giving you full preview control before anything is touched.",
    },
  };
  const chat = document.querySelector("#question-chat");
  const openChat = MacwipeUI.createChat(chat);
  let activeTrigger = null;

  document
    .querySelector(".questions-list")
    .addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-question]");
      const preset = questions[trigger?.dataset.question];
      if (!preset) return;
      activeTrigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      openChat(preset.question, preset.answer);
    });
  chat.addEventListener("close", () => {
    activeTrigger?.setAttribute("aria-expanded", "false");
    activeTrigger = null;
  });
})();
