const request = require('supertest');
const expect = require('expect.js');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const restGit = require('../source/git-api');
const git = require('../source/git-promise');
const common = require('./common-es6');

const app = express();
app.use(require('body-parser').json());
const socketsById = {};
restGit.registerApi({ app, config: { dev: true }, socketsById });
const req = request(app);

describe('git-api cancellable commit', () => {
  after(() => common.post(req, '/testing/cleanup'));

  it('streams output to its owner and only cancels a matching active operation', async () => {
    const repoPath = await common.createSmallRepo(req);
    const head = await git(['rev-parse', 'HEAD'], repoPath);
    await fs.writeFile(
      path.join(repoPath, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ntrap "" TERM\necho HOOK_READY >&2\nsleep 30\n',
      { mode: 0o755 }
    );
    let ready;
    const outputReady = new Promise((resolve) => {
      ready = resolve;
    });
    socketsById.owner = {
      emit: (event, data) => {
        if (event === 'commit-output' && data.output.includes('HOOK_READY')) ready(data);
      },
    };
    const payload = {
      path: repoPath,
      message: 'Cancel me',
      files: [],
      emptyCommit: true,
      operationId: 'test-commit',
      socketId: 'owner',
    };
    const pending = req
      .post(`${restGit.pathPrefix}/commit`)
      .send(payload)
      .then((response) => response);
    try {
      const output = await Promise.race([
        outputReady,
        pending.then(() => {
          throw new Error('Commit ended before streaming output');
        }),
      ]);
      expect(output.operationId).to.be(payload.operationId);
      const foreign = await req
        .post(`${restGit.pathPrefix}/commit/cancel`)
        .send({ ...payload, socketId: 'other' })
        .expect(200);
      expect(foreign.body.cancelled).to.be(false);
      await req.post(`${restGit.pathPrefix}/commit`).send(payload).expect(409);
      const cancel = await req
        .post(`${restGit.pathPrefix}/commit/cancel`)
        .send(payload)
        .expect(200);
      expect(cancel.body.cancelled).to.be(true);
      const result = await pending;
      expect(result.status).to.be(400);
      expect(result.body.errorCode).to.be('commit-cancelled');
      expect(await git(['rev-parse', 'HEAD'], repoPath)).to.be(head);
      const finished = await req
        .post(`${restGit.pathPrefix}/commit/cancel`)
        .send(payload)
        .expect(200);
      expect(finished.body.cancelled).to.be(false);
    } finally {
      await req.post(`${restGit.pathPrefix}/commit/cancel`).send(payload);
      await pending;
      delete socketsById.owner;
    }
  });
});
