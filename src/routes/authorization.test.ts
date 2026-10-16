import request from 'supertest';
import { describe, it } from 'vitest';
import { createApp } from '../app.js';

// Every id-bearing route must sit behind `requireAuth`; without a session the
// handler never runs, so cross-user access via a guessed id is impossible.
const app = createApp();

describe('route authorization', () => {
  it('rejects unauthenticated user search', async () => {
    await request(app).get('/api/v1/users/search').query({ q: 'alice' }).expect(401);
  });

  it('rejects unauthenticated public profile lookup', async () => {
    await request(app).get('/api/v1/users/64f123abc456def789012345').expect(401);
  });

  it('rejects unauthenticated settings access', async () => {
    await request(app).get('/api/v1/users/me/settings').expect(401);
  });

  it('rejects unauthenticated conversation message listing by id', async () => {
    await request(app).get('/api/v1/conversations/64f123abc456def789012347/messages').expect(401);
  });

  it('rejects unauthenticated message sending to a conversation id', async () => {
    await request(app)
      .post('/api/v1/conversations/64f123abc456def789012347/messages')
      .send({ content: 'hello' })
      .expect(401);
  });

  it('rejects unauthenticated conversation presence lookup', async () => {
    await request(app).get('/api/v1/conversations/64f123abc456def789012347/presence').expect(401);
  });

  it('rejects unauthenticated attachment upload to a conversation id', async () => {
    await request(app)
      .post('/api/v1/conversations/64f123abc456def789012347/attachments')
      .expect(401);
  });

  it('rejects unauthenticated message editing by id', async () => {
    await request(app)
      .patch('/api/v1/conversations/64f123abc456def789012347/messages/64f123abc456def789012348')
      .send({ content: 'edited' })
      .expect(401);
  });

  it('rejects unauthenticated message forwarding by id', async () => {
    await request(app)
      .post(
        '/api/v1/conversations/64f123abc456def789012347/messages/64f123abc456def789012348/forward',
      )
      .send({ conversationIds: ['64f123abc456def789012349'] })
      .expect(401);
  });

  it('rejects unauthenticated group rename', async () => {
    await request(app)
      .patch('/api/v1/conversations/64f123abc456def789012347')
      .send({ name: 'New name' })
      .expect(401);
  });

  it('rejects unauthenticated group icon upload', async () => {
    await request(app).post('/api/v1/conversations/64f123abc456def789012347/avatar').expect(401);
  });

  it('rejects unauthenticated group icon removal', async () => {
    await request(app).delete('/api/v1/conversations/64f123abc456def789012347/avatar').expect(401);
  });

  it('rejects unauthenticated group member invite', async () => {
    await request(app)
      .post('/api/v1/conversations/64f123abc456def789012347/participants')
      .send({ participantIds: ['64f123abc456def789012349'] })
      .expect(401);
  });
});
