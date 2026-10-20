const expect = require('expect.js');
const loadAiCommitMessage = require('../components/staging/load-ai-commit-message');

describe('asynchronous AI commit module loading', () => {
  let browser;
  let page;
  let scheduled;
  let scripts;

  beforeEach(() => {
    scheduled = null;
    scripts = [];
    browser = {
      ungit: {},
      requestIdleCallback: (callback) => (scheduled = callback),
      setTimeout: (callback) => (scheduled = callback),
    };
    page = {
      createElement: () => ({}),
      head: { appendChild: (script) => scripts.push(script) },
    };
  });

  it('defers script loading until idle and shares a single asynchronous load', async () => {
    const pending = loadAiCommitMessage('/custom-root', browser, page);
    expect(scripts).to.have.length(0);
    expect(loadAiCommitMessage('/custom-root', browser, page)).to.be(pending);
    scheduled();
    expect(scripts).to.have.length(1);
    expect(scripts[0].async).to.be(true);
    expect(scripts[0].src).to.be('/custom-root/plugins/staging/ai-commit-message.bundle.js');
    const Controller = class {};
    browser.ungit.AiCommitMessage = Controller;
    scripts[0].onload();
    expect(await pending).to.be(Controller);
  });

  it('uses a later task when idle callbacks are unavailable', async () => {
    delete browser.requestIdleCallback;
    const pending = loadAiCommitMessage('', browser, page);
    expect(scripts).to.have.length(0);
    scheduled();
    browser.ungit.AiCommitMessage = class {};
    scripts[0].onload();
    await pending;
  });

  it('rejects failed loads without permanently caching the failure', async () => {
    const pending = loadAiCommitMessage('', browser, page);
    scheduled();
    scripts[0].onerror();
    await pending.then(
      () => {
        throw new Error('Expected loading to fail');
      },
      (error) => expect(error.message).to.contain('could not be loaded')
    );
    const retry = loadAiCommitMessage('', browser, page);
    expect(retry).not.to.be(pending);
    scheduled();
    browser.ungit.AiCommitMessage = class {};
    scripts[1].onload();
    await retry;
  });
});
