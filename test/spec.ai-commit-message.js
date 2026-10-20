const expect = require('expect.js');
const ko = require('knockout');
const AiCommitMessage = require('../components/staging/ai-commit-message');

describe('automatic commit messages', () => {
  let ai;
  let vm;
  let browser;
  let page;
  let saved;
  let diff;
  let prompts;
  let destroyed;
  let respond;

  beforeEach(async () => {
    saved = {};
    diff = '+first change';
    prompts = [];
    destroyed = 0;
    respond = async () => JSON.stringify({ title: 'Add feature', body: 'Explain the change' });
    browser = new EventTarget();
    browser.LanguageModel = {
      availability: async () => 'available',
      create: async () => ({
        prompt: async (input) => {
          prompts.push(input);
          return respond();
        },
        destroy: () => destroyed++,
      }),
    };
    page = new EventTarget();
    page.hidden = false;
    page.hasFocus = () => true;
    vm = {
      commitMessageTitle: ko.observable(''),
      commitMessageBody: ko.observable(''),
      commitRunning: ko.observable(false),
      amend: ko.observable(false),
      emptyCommit: ko.observable(false),
      conflictText: ko.observable(''),
      repoPath: ko.observable('/repo'),
      currentBranch: ko.observable('feature/test'),
      files: ko.observableArray([
        {
          name: () => 'file.js',
          oldName: () => undefined,
          fileType: () => 'text',
          editState: ko.observable('staged'),
          patchLineList: ko.observableArray([]),
        },
      ]),
      server: { getPromise: async () => diff },
    };
    ai = new AiCommitMessage(
      vm,
      { getItem: (key) => saved[key], setItem: (key, value) => (saved[key] = value) },
      browser,
      page
    );
    ai.start();
    await ai.checkAvailability();
  });

  afterEach(() => ai.dispose());

  it('defaults to enabled and persists both toggle states', () => {
    expect(ai.enabled()).to.be(true);
    ai.toggle();
    expect(saved.aiCommitMessageEnabled).to.be('false');
    const restored = new AiCommitMessage(vm, { getItem: (key) => saved[key] }, browser, page);
    expect(restored.enabled()).to.be(false);
    restored.dispose();
    ai.toggle();
    expect(saved.aiCommitMessageEnabled).to.be('true');
  });

  it('only offers a download when the model reports downloadable', async () => {
    for (const availability of ['unavailable', 'downloadable', 'downloading']) {
      browser.LanguageModel.availability = async () => availability;
      await ai.checkAvailability();
      expect(ai.available()).to.be(false);
      expect(ai.downloadable()).to.be(availability === 'downloadable');
      await ai.generate();
    }
    delete browser.LanguageModel;
    await ai.checkAvailability();
    expect(ai.available()).to.be(false);
    expect(ai.downloadable()).to.be(false);
    expect(prompts).to.have.length(0);
  });

  it('downloads on click without blocking edits or changing the enabled preference', async () => {
    ai.enabled(false);
    browser.LanguageModel.availability = async () => 'downloadable';
    await ai.checkAvailability();
    let finish;
    let creates = 0;
    browser.LanguageModel.create = () => {
      creates++;
      return new Promise((resolve) => (finish = resolve));
    };
    const pending = ai.toggle();
    expect(creates).to.be(1);
    expect(ai.downloading()).to.be(true);
    ai.toggle();
    expect(creates).to.be(1);
    vm.commitMessageTitle('Human title during download');
    await ai.generate();
    expect(prompts).to.have.length(0);
    browser.LanguageModel.availability = async () => 'available';
    finish({ destroy: () => destroyed++ });
    await pending;
    expect(ai.downloading()).to.be(false);
    expect(ai.downloadable()).to.be(false);
    expect(ai.available()).to.be(true);
    expect(ai.enabled()).to.be(false);
    expect(vm.commitMessageTitle()).to.be('Human title during download');
    expect(destroyed).to.be(1);
  });

  it('allows retrying failed downloads', async () => {
    browser.LanguageModel.availability = async () => 'downloadable';
    await ai.checkAvailability();
    browser.LanguageModel.create = async () => {
      throw new Error('Download failed');
    };
    await ai.toggle();
    expect(ai.downloading()).to.be(false);
    expect(ai.downloadable()).to.be(true);
    expect(ai.available()).to.be(false);
    expect(vm.commitMessageTitle()).to.be('');
  });

  it('includes binary and large filenames without requesting or including their contents', async () => {
    vm.files()[0].fileType = () => 'image';
    vm.server.getPromise = async () => {
      throw new Error('Binary files must not be requested');
    };
    await ai.generate();
    expect(JSON.parse(prompts[0].split('\n\n')[1]).changes).to.eql([
      { file: 'file.js', selection: 'staged', contentOmitted: true },
    ]);
    vm.files()[0].fileType = () => 'text';
    for (const excluded of [null, 'x'.repeat(12001), 'Binary files a/file and b/file differ\n']) {
      vm.server.getPromise = async () => excluded;
      await ai.generate();
    }
    expect(prompts).to.have.length(1);
    expect(prompts[0]).not.to.contain('Binary files a/file');
    expect(prompts[0]).not.to.contain('x'.repeat(12001));
  });

  it('includes only complete file entries within the total prompt budget', async () => {
    const original = vm.files()[0];
    vm.files([
      ...Array.from({ length: 5 }, (_, index) => ({
        ...original,
        name: () => `file-${index}.js`,
      })),
      { ...original, name: () => 'excluded.png', fileType: () => 'image' },
    ]);
    vm.server.getPromise = async (endpoint) => {
      expect(endpoint).to.be('/diff/ai');
      return 'x'.repeat(10000);
    };
    await ai.generate();
    const input = prompts[0].split('\n\n').slice(1).join('\n\n');
    const changes = JSON.parse(input).changes;
    expect(input.length).to.be.lessThan(24001);
    expect(changes).to.have.length(6);
    const withDiffs = changes.filter((change) => change.diff);
    expect(withDiffs).to.have.length(2);
    expect(withDiffs.every((change) => change.diff.length === 10000)).to.be(true);
    expect(changes[5]).to.eql({
      file: 'excluded.png',
      selection: 'staged',
      contentOmitted: true,
    });
  });

  it('generates from diffs and regenerates only when their contents change', async () => {
    await ai.generate();
    expect(vm.commitMessageTitle()).to.be('Add feature');
    expect(vm.commitMessageBody()).to.be('Explain the change');
    expect(prompts[0]).to.contain(diff);
    expect(destroyed).to.be(1);
    ai.refresh();
    await ai.generate();
    expect(prompts).to.have.length(1);
    diff = '+other change with the same file and line count';
    respond = async () => JSON.stringify({ title: 'Update feature', body: 'New explanation' });
    ai.refresh();
    await ai.generate();
    expect(vm.commitMessageTitle()).to.be('Update feature');
    expect(prompts).to.have.length(2);
  });

  it('includes the current branch and regenerates for a branch change', async () => {
    await ai.generate();
    expect(JSON.parse(prompts[0].split('\n\n')[1]).branch).to.be('feature/test');
    vm.currentBranch('fix/redirect-handler');
    await ai.generate();
    expect(JSON.parse(prompts[1].split('\n\n')[1]).branch).to.be('fix/redirect-handler');
    vm.currentBranch(null);
    await ai.generate();
    expect(JSON.parse(prompts[2].split('\n\n')[1]).branch).to.be(null);
  });

  it('shows each preparation stage while leaving the form editable', async () => {
    let finishDiff;
    let finishModel;
    let finishResponse;
    vm.server.getPromise = () => new Promise((resolve) => (finishDiff = resolve));
    browser.LanguageModel.create = () => new Promise((resolve) => (finishModel = resolve));
    const pending = ai.generate();
    expect(ai.buttonText()).to.be('AI preparing message…');
    expect(ai.busy()).to.be(true);
    finishDiff(diff);
    await Promise.resolve();
    expect(ai.buttonText()).to.be('AI loading model…');
    finishModel({
      prompt: () => new Promise((resolve) => (finishResponse = resolve)),
      destroy: () => destroyed++,
    });
    await Promise.resolve();
    expect(ai.buttonText()).to.be('AI waiting for response…');
    vm.commitMessageTitle('Human title while waiting');
    finishResponse(JSON.stringify({ title: 'Stale response', body: 'Body' }));
    await pending;
    expect(vm.commitMessageTitle()).to.be('Human title while waiting');
    expect(ai.buttonText()).to.be('AI enabled');
    expect(ai.busy()).to.be(false);
  });

  it('indicates pending availability checks', async () => {
    let finish;
    browser.LanguageModel.availability = () => new Promise((resolve) => (finish = resolve));
    const pending = ai.checkAvailability();
    expect(ai.buttonText()).to.be('AI checking…');
    expect(ai.busy()).to.be(true);
    finish('available');
    await pending;
    expect(ai.buttonText()).to.be('AI enabled');
    expect(ai.busy()).to.be(false);
  });

  it('preserves human text in either field, including edits to generated content', async () => {
    for (const field of [vm.commitMessageTitle, vm.commitMessageBody]) {
      vm.commitMessageTitle('');
      vm.commitMessageBody('');
      field('Human text');
      await ai.generate();
      expect(field()).to.be('Human text');
    }
    expect(prompts).to.have.length(0);
    vm.commitMessageBody('');
    await ai.generate();
    vm.commitMessageBody('Human revision');
    diff = '+another change';
    ai.refresh();
    await ai.generate();
    expect(vm.commitMessageBody()).to.be('Human revision');
    expect(prompts).to.have.length(1);
  });

  it('requires focus, enabled AI, selected files, and a normal commit', async () => {
    for (const observable of [
      ai.focused,
      ai.enabled,
      vm.commitRunning,
      vm.amend,
      vm.emptyCommit,
      vm.conflictText,
    ]) {
      const previous = observable();
      observable(!previous);
      await ai.generate();
      observable(previous);
    }
    vm.files()[0].editState('none');
    await ai.generate();
    expect(prompts).to.have.length(0);
  });

  it('discards pending results after edits, blur, disabling, changes, navigation, or disposal', async () => {
    for (const invalidate of [
      () => vm.commitMessageBody('Typed while generating'),
      () => {
        page.hasFocus = () => false;
        browser.dispatchEvent(new Event('blur'));
      },
      () => ai.enabled(false),
      () => ai.refresh(),
      () => vm.repoPath('/other-repo'),
      () => vm.currentBranch('other-branch'),
      () => ai.dispose(),
    ]) {
      let finish;
      let started;
      const pending = new Promise((resolve) => (finish = resolve));
      const ready = new Promise((resolve) => (started = resolve));
      respond = () => {
        started();
        return pending;
      };
      const generating = ai.generate();
      await ready;
      invalidate();
      finish(JSON.stringify({ title: 'Stale title', body: 'Stale body' }));
      await generating;
      expect(vm.commitMessageTitle()).to.be('');
      expect(vm.commitMessageBody()).not.to.be('Stale body');
      vm.commitMessageBody('');
      page.hasFocus = () => true;
      ai.focused(true);
      ai.enabled(true);
    }
  });

  it('applies fenced JSON responses with surrounding whitespace or an omitted closing fence', async () => {
    const message = {
      title: 'Migrate redirectHandler to once listener for REDIRECT_TO_CLIENT_URL',
      body: 'Changed `TS_SDK.on` to `TS_SDK.once` for the REDIRECT_TO_CLIENT_URL event to ensure the redirect handler is only executed once.',
    };
    for (const response of [
      `\n  \`\`\`json\n${JSON.stringify(message, null, 2)}\n\`\`\`\n`,
      `\n\`\`\`JSON\n${JSON.stringify(message, null, 2)}\n`,
    ]) {
      vm.commitMessageTitle('');
      vm.commitMessageBody('');
      respond = async () => response;
      await ai.generate();
      expect(vm.commitMessageTitle()).to.be(message.title);
      expect(vm.commitMessageBody()).to.be(message.body);
    }
  });

  it('ignores malformed responses and model failures without changing the form', async () => {
    for (const response of ['not JSON', '{}', '{"title":"","body":"body"}']) {
      respond = async () => response;
      await ai.generate();
      expect(vm.commitMessageTitle()).to.be('');
      expect(vm.commitMessageBody()).to.be('');
    }
    browser.LanguageModel.create = async () => {
      throw new Error('Model failed');
    };
    await ai.generate();
    expect(vm.commitMessageTitle()).to.be('');
    expect(destroyed).to.be(3);
  });

  it('allows human edits while model initialization is pending', async () => {
    let finish;
    let started;
    const ready = new Promise((resolve) => (started = resolve));
    browser.LanguageModel.create = () => {
      started();
      return new Promise((resolve) => (finish = resolve));
    };
    const pending = ai.generate();
    await ready;
    vm.commitMessageTitle('Written while the model loads');
    expect(vm.commitMessageTitle()).to.be('Written while the model loads');
    finish({
      prompt: () => {
        throw new Error('A stale request must not reach inference');
      },
      destroy: () => destroyed++,
    });
    await pending;
    expect(vm.commitMessageTitle()).to.be('Written while the model loads');
    expect(prompts).to.have.length(0);
    expect(destroyed).to.be(1);
  });
});
