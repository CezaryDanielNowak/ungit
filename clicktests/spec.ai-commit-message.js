const expect = require('expect.js');
const environment = require('./environment')();
const repos = [];

describe('[AI COMMIT MESSAGE]', () => {
  before('Environment init', async () => {
    await environment.init();
    await environment.createRepos(repos, [{ bare: false, initCommits: 1 }]);
    await environment.openUngit(repos[0]);
  });

  after('Environment stop', () => environment.shutdown());

  it('does not render the toggle when the model is unavailable', async () => {
    await environment.page.evaluate(() => {
      Object.defineProperty(window, 'LanguageModel', {
        configurable: true,
        value: { availability: async () => 'unavailable' },
      });
      window.dispatchEvent(new Event('focus'));
    });
    await environment.page.waitForNetworkIdle();
    expect(await environment.page.$('.ai-commit-toggle')).to.be(null);
  });

  it('generates a message when modified files appear', async () => {
    await environment.page.evaluate(() => {
      Object.defineProperty(window, 'LanguageModel', {
        configurable: true,
        value: {
          availability: async () => 'available',
          create: async () => ({
            prompt: async () =>
              JSON.stringify({ title: 'Add test file', body: 'Create a file for testing.' }),
            destroy: () => {},
          }),
        },
      });
      window.dispatchEvent(new Event('focus'));
    });
    await environment.page.bringToFront();
    await environment.waitForElementVisible('.repository-actions');
    await environment.createTestFile(`${repos[0]}/ai-test.txt`, repos[0]);
    await environment.waitForElementVisible('.ai-commit-toggle');
    await environment.page.waitForFunction(
      () => document.querySelector('.staging input.form-control').value === 'Add test file'
    );
    expect(await environment.page.$eval('.commit-body', (el) => el.value)).to.be(
      'Create a file for testing.'
    );
    expect(await environment.page.$eval('.ai-commit-toggle', (el) => el.textContent)).to.be(
      'AI enabled'
    );
  });

  it('keeps human edits when another modified file appears', async () => {
    await environment.insert('.staging input.form-control', 'Human title');
    await environment.createTestFile(`${repos[0]}/another-ai-test.txt`, repos[0]);
    await environment.page.waitForFunction(
      () => document.querySelectorAll('.staging .files .file').length === 2
    );
    await environment.page.waitForNetworkIdle({ idleTime: 1000 });
    expect(await environment.page.$eval('.staging input.form-control', (el) => el.value)).to.be(
      'Human title'
    );
  });

  it('stores disabled AI in localStorage', async () => {
    await environment.click('.ai-commit-toggle');
    await environment.page.waitForNetworkIdle({ idleTime: 1000 });
    expect(await environment.page.$eval('.ai-commit-toggle', (el) => el.textContent)).to.be(
      'AI disabled'
    );
    expect(
      // This callback executes in Chrome.
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      await environment.page.evaluate(() => window.localStorage.getItem('aiCommitMessageEnabled'))
    ).to.be('false');
  });
});
