'use strict';
const expect = require('expect.js');
const fs = require('fs').promises;
const path = require('path');
const git = require('../source/git-promise');
const environment = require('./environment')();
const repos = [];

const writeHook = (name, script) =>
  fs.writeFile(path.join(repos[0], '.git', 'hooks', name), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });

async function prepareCommit(title) {
  await environment.click('.empty-commit-link');
  await environment.insert('.staging input.form-control', title);
}

describe('[COMMIT PROGRESS]', () => {
  before('Environment init', async () => {
    await environment.init();
    await environment.createRepos(repos, [{ bare: false, initCommits: 1 }, { bare: true }]);
    await environment.backgroundAction('POST', '/api/remotes/origin', {
      path: repos[0],
      url: repos[1],
    });
    await environment.openUngit(repos[0]);
  });

  after('Environment stop', () => environment.shutdown());

  it('shows stdout and stderr after 500 ms while the hook is still running', async () => {
    await writeHook(
      'pre-commit',
      'echo "stdout: checking"\necho "stderr: checking" >&2\nsleep 3\necho "checks finished"'
    );
    await prepareCommit('Slow successful commit');
    await environment.page.evaluate(() => {
      const button = document.querySelector('.commit-btn');
      const output = document.querySelector('.commit-console');
      button.addEventListener(
        'click',
        () => {
          const started = performance.now();
          const observer = new MutationObserver(() => {
            if (output.style.display !== 'none') {
              window.consoleDelay = performance.now() - started;
              observer.disconnect();
            }
          });
          observer.observe(output, { attributes: true, attributeFilter: ['style'] });
        },
        { once: true }
      );
    });
    await environment.page.click('.commit-btn');
    await environment.waitForElementVisible('.commit-console');
    await environment.waitForElementHidden('.staging-controls');
    expect(await environment.page.evaluate(() => window.consoleDelay)).to.be.above(490);
    await environment.page.waitForFunction(() => {
      const output = document.querySelector('.commit-console pre').textContent;
      return output.includes('stdout: checking') && output.includes('stderr: checking');
    });
    expect(await environment.page.$eval('.commit-btn', (el) => el.disabled)).to.be(true);
    await environment.waitForElementVisible('.cancel-commit');
    await environment.waitForElementVisible(
      '[data-ta-node-title="Slow successful commit"] .commit-container'
    );
    await environment.waitForElementHidden('.cancel-commit');
    expect(await environment.page.$eval('.commit-console pre', (el) => el.textContent)).to.contain(
      'checks finished'
    );
  });

  it('cancels hook subprocesses without committing or pushing and allows retry', async () => {
    const before = (await git(['rev-parse', 'HEAD'], repos[0])).trim();
    await writeHook(
      'pre-commit',
      'echo "waiting for child"\n(sleep 3; echo ran > cancelled-child-ran) &\nwait'
    );
    await prepareCommit('Cancelled commit');
    await environment.click('.commit-grp .dropdown-toggle');
    await environment.click('.commitnpush');
    let pushes = 0;
    const listener = (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/push')) pushes++;
    };
    environment.page.on('request', listener);
    await environment.page.click('.commit-btn');
    await environment.waitForElementVisible('.cancel-commit');
    await environment.page.click('.cancel-commit');
    await environment.waitForElementHidden('.cancel-commit');
    expect(
      await environment.page.$eval('.commit-console strong', (el) => el.textContent)
    ).to.contain('cancelled');
    expect((await git(['rev-parse', 'HEAD'], repos[0])).trim()).to.be(before);
    expect(await environment.page.$eval('.staging input.form-control', (el) => el.value)).to.be(
      'Cancelled commit'
    );
    await environment.wait(3500);
    expect(
      await fs.access(path.join(repos[0], 'cancelled-child-ran')).then(
        () => true,
        () => false
      )
    ).to.be(false);
    expect(pushes).to.be(0);
    environment.page.off('request', listener);
    await environment.click('.dismiss-commit');
    await environment.click('.commit-grp .dropdown-toggle');
    await environment.click('.commit-skip-hooks');
    await environment.click('.commit-btn');
    await environment.waitForElementVisible(
      '[data-ta-node-title="Cancelled commit"] .commit-container'
    );
    await fs.unlink(path.join(repos[0], '.git', 'hooks', 'pre-commit'));
  });

  it('keeps an already-created commit when cancelling a post-commit hook', async () => {
    await writeHook('post-commit', 'echo "post-commit running"\nsleep 10');
    await prepareCommit('Commit already created');
    await environment.click('.commit-grp .dropdown-toggle');
    await environment.click('.commit-only');
    await environment.page.click('.commit-btn');
    await environment.waitForElementVisible('.cancel-commit');
    await environment.page.waitForFunction(() =>
      document.querySelector('.commit-console pre').textContent.includes('post-commit running')
    );
    await environment.page.click('.cancel-commit');
    await environment.waitForElementHidden('.cancel-commit');
    expect((await git(['log', '-1', '--format=%s'], repos[0])).trim()).to.be(
      'Commit already created'
    );
    await fs.unlink(path.join(repos[0], '.git', 'hooks', 'post-commit'));
    await environment.click('.dismiss-commit');
  });

  it('retains hook failure output and the commit message', async () => {
    await environment.click('.btn-stg-cancel');
    const before = await git(['rev-parse', 'HEAD'], repos[0]);
    await writeHook(
      'pre-commit',
      'echo "checking files"\nsleep 1\necho "hook rejected commit" >&2\nexit 1'
    );
    await prepareCommit('Rejected commit');
    await environment.page.click('.commit-btn');
    await environment.waitForElementVisible('.commit-console');
    await environment.page.waitForFunction(
      () =>
        document.querySelector('.commit-console strong').textContent === 'Commit failed.' &&
        document.querySelector('.commit-console pre').textContent.includes('hook rejected commit')
    );
    expect(await environment.page.$eval('.commit-console pre', (el) => el.textContent)).to.contain(
      'hook rejected commit'
    );
    expect(await environment.page.$eval('.staging input.form-control', (el) => el.value)).to.be(
      'Rejected commit'
    );
    expect(await git(['rev-parse', 'HEAD'], repos[0])).to.be(before);
    await environment.waitForElementVisible('.dismiss-commit');
    await environment.waitForElementHidden('.staging-controls');
    await environment.waitForElementHidden('.modal-dialog');
    await environment.wait(1200);
    await environment.waitForElementVisible('.commit-console');
  });

  it('keeps failed output when a file event leaves nothing to commit', async () => {
    const filename = path.join(repos[0], 'testy0');
    const content = await fs.readFile(filename);
    const refreshed = environment.setApiListener('/status?', 'GET');
    await fs.writeFile(filename, content);
    await refreshed;
    await environment.page.waitForNetworkIdle();
    expect((await git(['status', '--porcelain'], repos[0])).trim()).to.be('');
    await environment.waitForElementVisible('.commit-console');
    await environment.waitForElementVisible('.dismiss-commit');
    await environment.waitForElementHidden('.staging-controls');
  });

  it('dismisses failed output without losing the message', async () => {
    await environment.click('.dismiss-commit');
    await environment.waitForElementHidden('.commit-console');
    await environment.waitForElementVisible('.staging-controls');
    expect(await environment.page.$eval('.staging input.form-control', (el) => el.value)).to.be(
      'Rejected commit'
    );
  });

  for (const change of ['add', 'edit', 'delete']) {
    it(`dismisses failed output after a file ${change}`, async () => {
      await environment.page.click('.commit-btn');
      await environment.waitForElementVisible('.dismiss-commit');
      await environment.page.waitForFunction(
        () => document.querySelector('.commit-console strong').textContent === 'Commit failed.'
      );
      const filename = path.join(repos[0], 'changed-code.js');
      if (change === 'delete') await fs.unlink(filename);
      else
        await fs.writeFile(
          filename,
          change === 'add' ? 'const value = 1;\n' : 'const value = 2;\n'
        );
      await environment.waitForElementHidden('.commit-console');
      await environment.waitForElementVisible('.staging-controls');
      expect(await environment.page.$eval('.staging input.form-control', (el) => el.value)).to.be(
        'Rejected commit'
      );
    });
  }
});
