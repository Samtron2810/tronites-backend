import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../index.js";
import { createTestUser, TEST_ORIGIN } from "./helpers.js";

describe("Auth", () => {
  it("logs in with correct email + password and sets an auth cookie", async () => {
    const { user, password } = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ identifier: user.email, password });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
    // toPrivateSelfDTO deliberately excludes the password hash — see
    // dtos/userDTO.js.
    expect(res.body.password).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["set-cookie"][0]).toMatch(/^token=/);
  });

  it("logs in with username instead of email", async () => {
    const { user, password } = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ identifier: user.username, password });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(user.username);
  });

  it("rejects an incorrect password", async () => {
    const { user } = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ identifier: user.email, password: "WrongPassword123!" });

    expect(res.status).toBe(400);
  });

  it("rejects a login attempt for a nonexistent account with the same generic message (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ identifier: "nobody@example.com", password: "whatever123" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid email/username or password");
  });

  it("GET /api/auth/me returns the current user when authenticated", async () => {
    const { user, password } = await createTestUser();

    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .set("Origin", TEST_ORIGIN)
      .send({ identifier: user.email, password });

    const res = await agent.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
  });

  it("GET /api/auth/me without a cookie is rejected", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
