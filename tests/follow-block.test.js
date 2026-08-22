import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../index.js";
import { createTestUser, authCookieFor, TEST_ORIGIN } from "./helpers.js";

describe("Follow", () => {
  it("follows a user, then unfollows via the same toggle endpoint", async () => {
    const { user: follower } = await createTestUser();
    const { user: target } = await createTestUser();

    const followRes = await request(app)
      .put(`/api/users/follow/${target._id}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(follower));

    expect(followRes.status).toBe(200);
    expect(followRes.body.following).toBe(true);

    const unfollowRes = await request(app)
      .put(`/api/users/follow/${target._id}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(follower));

    expect(unfollowRes.status).toBe(200);
    expect(unfollowRes.body.following).toBe(false);
  });

  it("cannot follow without auth", async () => {
    const { user: target } = await createTestUser();

    const res = await request(app)
      .put(`/api/users/follow/${target._id}`)
      .set("Origin", TEST_ORIGIN);

    expect(res.status).toBe(401);
  });
});

describe("Block", () => {
  it("blocks a user, then unblocks", async () => {
    const { user: blocker } = await createTestUser();
    const { user: target } = await createTestUser();

    const blockRes = await request(app)
      .post(`/api/users/${target._id}/block`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(blocker));

    expect(blockRes.status).toBe(200);
    expect(blockRes.body.blocked).toBe(true);

    const statusRes = await request(app)
      .get(`/api/users/${target._id}/block-status`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(blocker));
    expect(statusRes.body.iBlockedThem).toBe(true);

    const unblockRes = await request(app)
      .delete(`/api/users/${target._id}/block`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(blocker));

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.blocked).toBe(false);
  });

  it("a blocked user can't like the blocker's post", async () => {
    const { user: author } = await createTestUser();
    const { user: blockedUser } = await createTestUser();

    await request(app)
      .post(`/api/users/${blockedUser._id}/block`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(author));

    const createRes = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(author))
      .field("text", "you can't like this");
    const postId = createRes.body._id;

    const likeRes = await request(app)
      .put(`/api/posts/like/${postId}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(blockedUser));

    expect(likeRes.status).toBe(403);
  });
});
