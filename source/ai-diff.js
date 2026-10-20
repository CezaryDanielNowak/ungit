const fs = require('fs').promises;
const path = require('path');
const { maxFileBytes, maxDiffChars } = require('./ai-commit-limits');

// Check both versions before asking Git to produce a potentially expensive diff.
module.exports = async function aiDiff(git, repoPath, filename, oldFilename) {
  if (typeof filename !== 'string' || !filename) return null;
  const relative = path.relative(repoPath, path.resolve(repoPath, filename));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    return null;
  }
  const stat = await fs.lstat(path.join(repoPath, filename)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.size > maxFileBytes)) return null;
  const previousSize = await git(
    ['cat-file', '-s', `HEAD:${oldFilename || filename}`],
    repoPath
  ).catch(() => null);
  if (previousSize !== null && Number(previousSize) > maxFileBytes) return null;
  const diff = await git.diffFile(repoPath, filename, oldFilename, '', false);
  if (
    typeof diff !== 'string' ||
    !diff.trim() ||
    diff.length > maxDiffChars ||
    diff.includes('\0') ||
    /^Binary files .* differ$|^GIT binary patch$/m.test(diff)
  ) {
    return null;
  }
  return diff;
};
