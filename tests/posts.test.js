import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../index.js";
import { createTestUser, authCookieFor, TEST_ORIGIN } from "./helpers.js";

describe("Posts", () => {
  it("creates a text-only post", async () => {
    const { user } = await createTestUser();

    const res = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(user))
      .field("text", "hello from a smoke test");

    expect(res.status).toBe(201);
    expect(res.body.text).toBe("hello from a smoke test");
    expect(res.body.likesCount).toBe(0);
  });

  it("rejects a post with neither text nor an image", async () => {
    const { user } = await createTestUser();

    const res = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(user))
      .field("text", "");

    expect(res.status).toBe(400);
  });

  it("rejects post creation without auth", async () => {
    const res = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .field("text", "no cookie attached");

    expect(res.status).toBe(401);
  });

  it("likes a post, then unlikes it, count tracks correctly", async () => {
    const { user: author } = await createTestUser();
    const { user: liker } = await createTestUser();

    const createRes = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(author))
      .field("text", "like me");
    const postId = createRes.body._id;

    const likeRes = await request(app)
      .put(`/api/posts/like/${postId}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(liker));

    expect(likeRes.status).toBe(200);
    expect(likeRes.body.liked).toBe(true);
    expect(likeRes.body.likes).toBe(1);

    const unlikeRes = await request(app)
      .put(`/api/posts/like/${postId}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(liker));

    expect(unlikeRes.status).toBe(200);
    expect(unlikeRes.body.liked).toBe(false);
    expect(unlikeRes.body.likes).toBe(0);
  });

  it("only the post's author can delete it", async () => {
    const { user: author } = await createTestUser();
    const { user: intruder } = await createTestUser();

    const createRes = await request(app)
      .post("/api/posts")
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(author))
      .field("text", "do not delete me");
    const postId = createRes.body._id;

    const deniedRes = await request(app)
      .delete(`/api/posts/${postId}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(intruder));
    expect(deniedRes.status).toBe(403);

    const okRes = await request(app)
      .delete(`/api/posts/${postId}`)
      .set("Origin", TEST_ORIGIN)
      .set("Cookie", authCookieFor(author));
    expect(okRes.status).toBe(200);
  });
});
