const expect = require('expect.js');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const git = require('../source/git-promise');
const aiDiff = require('../source/ai-diff');
const { maxFileBytes } = require('../source/ai-commit-limits');

describe('AI diff limits', () => {
  let repo;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ungit-ai-diff-'));
    await git(['init'], repo);
    await fs.writeFile(path.join(repo, 'small.txt'), 'original\n');
    await fs.writeFile(path.join(repo, 'large.txt'), 'x'.repeat(maxFileBytes + 1));
    await git(['add', '.'], repo);
    await git(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial'],
      repo
    );
  });

  afterEach(() => fs.rm(repo, { recursive: true, force: true }));

  it('includes ordinary text diffs', async () => {
    await fs.writeFile(path.join(repo, 'small.txt'), 'updated\n');
    expect(await aiDiff(git, repo, 'small.txt')).to.contain('+updated');
  });

  it('skips large untracked files before producing a diff', async () => {
    await fs.writeFile(path.join(repo, 'new.txt'), 'x'.repeat(maxFileBytes + 1));
    const unexpectedGit = () => {
      throw new Error('Large files must be rejected before running Git');
    };
    expect(await aiDiff(unexpectedGit, repo, 'new.txt')).to.be(null);
  });

  it('skips deleted or reduced files whose committed version is too large', async () => {
    await fs.unlink(path.join(repo, 'large.txt'));
    expect(await aiDiff(git, repo, 'large.txt')).to.be(null);
    await fs.writeFile(path.join(repo, 'large.txt'), 'small now\n');
    expect(await aiDiff(git, repo, 'large.txt')).to.be(null);
  });

  it('skips binary files even with a text filename extension', async () => {
    await fs.writeFile(path.join(repo, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
    expect(await aiDiff(git, repo, 'binary.txt')).to.be(null);
  });

  it('skips oversized diffs even when the file itself is under the size limit', async () => {
    await fs.writeFile(path.join(repo, 'small.txt'), 'x'.repeat(13000));
    expect(await aiDiff(git, repo, 'small.txt')).to.be(null);
  });
});
