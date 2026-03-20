const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Identity & Authentication Service",
    version: "1.0.0",
    description: "Manages user registration, login, and role-based access for the Ghana Emergency Response Platform."
  },
  servers: [{ url: "http://localhost:3001", description: "Local" }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT"
      }
    },
    schemas: {
      User: {
        type: "object",
        properties: {
          _id:          { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          name:         { type: "string", example: "Kofi Mensah" },
          email:        { type: "string", example: "kofi@police.gov.gh" },
          role:         { type: "string", enum: ["system_admin","hospital_admin","police_admin","fire_admin","ambulance_driver"] },
          created_at:   { type: "string", format: "date-time" }
        }
      },
      RegisterRequest: {
        type: "object",
        required: ["name","email","password","role"],
        properties: {
          name:     { type: "string", example: "Kofi Mensah" },
          email:    { type: "string", example: "kofi@police.gov.gh" },
          password: { type: "string", example: "securepassword" },
          role:     { type: "string", enum: ["system_admin","hospital_admin","police_admin","fire_admin","ambulance_driver"] }
        }
      },
      LoginRequest: {
        type: "object",
        required: ["email","password"],
        properties: {
          email:    { type: "string", example: "kofi@police.gov.gh" },
          password: { type: "string", example: "securepassword" }
        }
      },
      LoginResponse: {
        type: "object",
        properties: {
          token:         { type: "string" },
          refresh_token: { type: "string" },
          user:          { $ref: "#/components/schemas/User" }
        }
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } }
      }
    }
  },
  paths: {
    "/auth/register": {
      post: {
        tags: ["Authentication"],
        summary: "Register a new user",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } }
        },
        responses: {
          201: { description: "User created", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Email already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/auth/login": {
      post: {
        tags: ["Authentication"],
        summary: "Login and receive JWT tokens",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } }
        },
        responses: {
          200: { description: "Login successful", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } },
          401: { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/auth/refresh-token": {
      post: {
        tags: ["Authentication"],
        summary: "Refresh an expired access token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["refresh_token"], properties: { refresh_token: { type: "string" } } } } }
        },
        responses: {
          200: { description: "New access token", content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } } },
          401: { description: "Invalid refresh token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/auth/profile": {
      get: {
        tags: ["Users"],
        summary: "Get the current user's profile",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "User profile", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/auth/verify": {
      get: {
        tags: ["Authentication"],
        summary: "Verify a JWT token (used internally by other services)",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Token is valid", content: { "application/json": { schema: { type: "object", properties: { valid: { type: "boolean" }, user: { $ref: "#/components/schemas/User" } } } } } },
          401: { description: "Invalid token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/auth/users": {
      get: {
        tags: ["Users"],
        summary: "List all users (system_admin only)",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "List of users", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } } },
          403: { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    }
  }
};

module.exports = swaggerDocument;
