const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Dispatch Tracking Service",
    version: "1.0.0",
    description: "Manages real-time GPS tracking of emergency vehicles. Broadcasts live location updates to connected dashboards via WebSocket."
  },
  servers: [{ url: "http://localhost:3003", description: "Local" }],
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      Vehicle: {
        type: "object",
        properties: {
          _id:          { type: "string" },
          vehicle_id:   { type: "string", example: "AMB-001" },
          vehicle_name: { type: "string", example: "Korle-Bu Ambulance 1" },
          vehicle_type: { type: "string", example: "ambulance" },
          incident_id:  { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          latitude:     { type: "number", example: 5.6037 },
          longitude:    { type: "number", example: -0.1870 },
          status:       { type: "string", enum: ["idle","dispatched","on_scene","returning"], example: "dispatched" },
          updated_at:   { type: "string", format: "date-time" }
        }
      },
      RegisterVehicleRequest: {
        type: "object",
        required: ["vehicle_id","vehicle_name","vehicle_type"],
        properties: {
          vehicle_id:   { type: "string", example: "AMB-001" },
          vehicle_name: { type: "string", example: "Korle-Bu Ambulance 1" },
          vehicle_type: { type: "string", example: "ambulance" },
          latitude:     { type: "number", example: 5.5332 },
          longitude:    { type: "number", example: -0.2068 }
        }
      },
      LocationUpdate: {
        type: "object",
        required: ["latitude","longitude"],
        properties: {
          latitude:  { type: "number", example: 5.6037 },
          longitude: { type: "number", example: -0.1870 },
          status:    { type: "string", example: "on_scene" }
        }
      },
      LocationHistory: {
        type: "object",
        properties: {
          vehicle_id:  { type: "string", example: "AMB-001" },
          latitude:    { type: "number" },
          longitude:   { type: "number" },
          recorded_at: { type: "string", format: "date-time" }
        }
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } }
      }
    }
  },
  paths: {
    "/vehicles/register": {
      post: {
        tags: ["Vehicles"],
        summary: "Register or update a vehicle",
        description: "Creates a new vehicle entry or updates an existing one by vehicle_id.",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterVehicleRequest" } } }
        },
        responses: {
          201: { description: "Vehicle registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Vehicle" } } } },
          400: { description: "Missing required fields" },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/vehicles/assign": {
      post: {
        tags: ["Vehicles"],
        summary: "Assign a vehicle to an incident",
        description: "Called internally by the Incident Service (or via event bus) when a responder is dispatched.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["vehicle_id","incident_id"],
                properties: {
                  vehicle_id:  { type: "string", example: "AMB-001" },
                  incident_id: { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" }
                }
              }
            }
          }
        },
        responses: {
          200: { description: "Vehicle assigned", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          400: { description: "Missing fields" }
        }
      }
    },
    "/vehicles": {
      get: {
        tags: ["Vehicles"],
        summary: "List all vehicles with their current location",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "All vehicles", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Vehicle" } } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/vehicles/{id}/location": {
      get: {
        tags: ["Vehicles"],
        summary: "Get the current location of a specific vehicle",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, description: "vehicle_id (e.g. AMB-001)", schema: { type: "string" } }],
        responses: {
          200: { description: "Vehicle location", content: { "application/json": { schema: { $ref: "#/components/schemas/Vehicle" } } } },
          404: { description: "Not found" }
        }
      },
      put: {
        tags: ["Vehicles"],
        summary: "Update vehicle GPS location",
        description: "Called by the ambulance driver's device to push GPS updates. Broadcasts the update to all connected WebSocket dashboards.",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, description: "vehicle_id (e.g. AMB-001)", schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LocationUpdate" } } }
        },
        responses: {
          200: { description: "Location updated and broadcast to dashboards", content: { "application/json": { schema: { $ref: "#/components/schemas/Vehicle" } } } },
          404: { description: "Vehicle not found" }
        }
      }
    },
    "/vehicles/{id}/history": {
      get: {
        tags: ["Vehicles"],
        summary: "Get the last 50 GPS records for a vehicle",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, description: "vehicle_id", schema: { type: "string" } }],
        responses: {
          200: { description: "Location history", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/LocationHistory" } } } } }
        }
      }
    }
  }
};

module.exports = swaggerDocument;
