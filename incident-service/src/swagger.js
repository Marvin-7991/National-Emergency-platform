const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Emergency Incident Service",
    version: "1.0.0",
    description: "Records and manages emergency incidents. Automatically assigns the nearest available responder and hospital based on incident type and location."
  },
  servers: [{ url: "http://localhost:3002", description: "Local" }],
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      Incident: {
        type: "object",
        properties: {
          _id:           { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          citizen_name:  { type: "string", example: "Ama Owusu" },
          incident_type: { type: "string", example: "Medical Emergency" },
          latitude:      { type: "number", example: 5.6037 },
          longitude:     { type: "number", example: -0.1870 },
          notes:         { type: "string", example: "Patient is unconscious" },
          created_by:    { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          assigned_unit: { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          hospital_id:   { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" },
          status:        { type: "string", enum: ["created","dispatched","in_progress","resolved"] },
          created_at:    { type: "string", format: "date-time" },
          updated_at:    { type: "string", format: "date-time" }
        }
      },
      CreateIncidentRequest: {
        type: "object",
        required: ["citizen_name","incident_type","latitude","longitude"],
        properties: {
          citizen_name:  { type: "string", example: "Ama Owusu" },
          incident_type: { type: "string", example: "Medical Emergency", description: "e.g. Medical Emergency, Fire, Robbery, Explosion" },
          latitude:      { type: "number", example: 5.6037 },
          longitude:     { type: "number", example: -0.1870 },
          notes:         { type: "string", example: "Patient is unconscious" }
        }
      },
      Responder: {
        type: "object",
        properties: {
          _id:          { type: "string" },
          name:         { type: "string", example: "Korle-Bu Ambulance Unit 1" },
          type:         { type: "string", enum: ["police","fire","ambulance"] },
          latitude:     { type: "number", example: 5.5332 },
          longitude:    { type: "number", example: -0.2068 },
          is_available: { type: "boolean", example: true },
          created_at:   { type: "string", format: "date-time" }
        }
      },
      CreateResponderRequest: {
        type: "object",
        required: ["name","type","latitude","longitude"],
        properties: {
          name:      { type: "string", example: "Accra Central Police Station" },
          type:      { type: "string", enum: ["police","fire","ambulance"] },
          latitude:  { type: "number", example: 5.5502 },
          longitude: { type: "number", example: -0.2174 }
        }
      },
      Hospital: {
        type: "object",
        properties: {
          _id:            { type: "string" },
          name:           { type: "string", example: "Korle-Bu Teaching Hospital" },
          latitude:       { type: "number", example: 5.5332 },
          longitude:      { type: "number", example: -0.2068 },
          capacity:       { type: "integer", example: 200 },
          available_beds: { type: "integer", example: 45 },
          created_at:     { type: "string", format: "date-time" }
        }
      },
      CreateHospitalRequest: {
        type: "object",
        required: ["name","latitude","longitude"],
        properties: {
          name:           { type: "string", example: "37 Military Hospital" },
          latitude:       { type: "number", example: 5.6037 },
          longitude:      { type: "number", example: -0.1870 },
          capacity:       { type: "integer", example: 150 },
          available_beds: { type: "integer", example: 30 }
        }
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } }
      }
    }
  },
  paths: {
    "/incidents": {
      post: {
        tags: ["Incidents"],
        summary: "Create a new incident",
        description: "Records an emergency incident and automatically assigns the nearest available responder. For medical emergencies, also assigns the nearest hospital with available beds.",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateIncidentRequest" } } }
        },
        responses: {
          201: { description: "Incident created and responder assigned", content: { "application/json": { schema: { $ref: "#/components/schemas/Incident" } } } },
          400: { description: "Missing required fields", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/incidents/open": {
      get: {
        tags: ["Incidents"],
        summary: "Get all open (non-resolved) incidents",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "List of open incidents with responder and hospital details", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Incident" } } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/incidents/all": {
      get: {
        tags: ["Incidents"],
        summary: "Get all incidents (including resolved)",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "All incidents", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Incident" } } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/incidents/stats/summary": {
      get: {
        tags: ["Incidents"],
        summary: "Get incident statistics summary (used by Analytics Service)",
        responses: {
          200: {
            description: "Incident statistics",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total:                 { type: "integer" },
                    by_status:             { type: "array", items: { type: "object", properties: { _id: { type: "string" }, count: { type: "integer" } } } },
                    by_type:               { type: "array", items: { type: "object", properties: { _id: { type: "string" }, count: { type: "integer" } } } },
                    avg_response_minutes:  { type: "string", example: "12.4" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/incidents/{id}": {
      get: {
        tags: ["Incidents"],
        summary: "Get a single incident by ID",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Incident details", content: { "application/json": { schema: { $ref: "#/components/schemas/Incident" } } } },
          404: { description: "Not found" },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/incidents/{id}/status": {
      put: {
        tags: ["Incidents"],
        summary: "Update incident status",
        description: "When set to 'resolved', the assigned responder is marked available again and any reserved hospital bed is released.",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: { status: { type: "string", enum: ["created","dispatched","in_progress","resolved"] } }
              }
            }
          }
        },
        responses: {
          200: { description: "Updated incident", content: { "application/json": { schema: { $ref: "#/components/schemas/Incident" } } } },
          400: { description: "Invalid status" },
          404: { description: "Not found" }
        }
      }
    },
    "/incidents/{id}/assign": {
      put: {
        tags: ["Incidents"],
        summary: "Manually assign a responder to an incident",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["responder_id"],
                properties: { responder_id: { type: "string", example: "664f1a2b3c4d5e6f7a8b9c0d" } }
              }
            }
          }
        },
        responses: {
          200: { description: "Incident with new assignment", content: { "application/json": { schema: { $ref: "#/components/schemas/Incident" } } } },
          404: { description: "Incident or responder not found" }
        }
      }
    },
    "/responders": {
      get: {
        tags: ["Responders"],
        summary: "List all responder units",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "All responders", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Responder" } } } } }
        }
      },
      post: {
        tags: ["Responders"],
        summary: "Register a new responder unit",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateResponderRequest" } } }
        },
        responses: {
          201: { description: "Responder created", content: { "application/json": { schema: { $ref: "#/components/schemas/Responder" } } } },
          400: { description: "Missing or invalid fields" }
        }
      }
    },
    "/hospitals": {
      get: {
        tags: ["Hospitals"],
        summary: "List all hospitals",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "All hospitals", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Hospital" } } } } }
        }
      },
      post: {
        tags: ["Hospitals"],
        summary: "Register a new hospital",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateHospitalRequest" } } }
        },
        responses: {
          201: { description: "Hospital created", content: { "application/json": { schema: { $ref: "#/components/schemas/Hospital" } } } },
          400: { description: "Missing required fields" }
        }
      }
    },
    "/hospitals/{id}": {
      put: {
        tags: ["Hospitals"],
        summary: "Update hospital details or bed availability",
        security: [{ BearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name:           { type: "string" },
                  latitude:       { type: "number" },
                  longitude:      { type: "number" },
                  capacity:       { type: "integer" },
                  available_beds: { type: "integer" }
                }
              }
            }
          }
        },
        responses: {
          200: { description: "Updated hospital", content: { "application/json": { schema: { $ref: "#/components/schemas/Hospital" } } } },
          404: { description: "Not found" }
        }
      }
    }
  }
};

module.exports = swaggerDocument;
