const loads = new WeakMap();

module.exports = function loadAiCommitMessage(rootPath, browser = window, page = document) {
  if (loads.has(browser)) return loads.get(browser);
  const loading = new Promise((resolve, reject) => {
    const load = () => {
      const script = page.createElement('script');
      script.async = true;
      script.src = `${rootPath || ''}/plugins/staging/ai-commit-message.bundle.js`;
      script.onload = () => {
        if (browser.ungit?.AiCommitMessage) resolve(browser.ungit.AiCommitMessage);
        else reject(new Error('AI commit message module did not load'));
      };
      script.onerror = () => reject(new Error('AI commit message module could not be loaded'));
      page.head.appendChild(script);
    };
    // Let the commit form paint and handle input before loading optional AI code.
    if (browser.requestIdleCallback) browser.requestIdleCallback(load, { timeout: 1000 });
    else browser.setTimeout(load, 0);
  }).catch((error) => {
    loads.delete(browser);
    throw error;
  });
  loads.set(browser, loading);
  return loading;
};
