const amqp = require('amqplib');
let connection = null;
let channel = null;

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

// Event types
const EVENTS = {
  INCIDENT_CREATED: 'incident.created',
  INCIDENT_UPDATED: 'incident.updated',
  INCIDENT_ASSIGNED: 'incident.assigned',
  RESPONDER_ASSIGNED: 'responder.assigned',
  HOSPITAL_ASSIGNED: 'hospital.assigned'
};

async function connect() {
  try {
    if (connection) return channel;
    
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    
    await channel.prefetch(1);
    
    // Declare exchanges
    await channel.assertExchange('incidents', 'topic', { durable: true });
    await channel.assertExchange('dispatch', 'topic', { durable: true });
    await channel.assertExchange('analytics', 'topic', { durable: true });
    
    console.log('✓ Connected to RabbitMQ');
    return channel;
  } catch (error) {
    console.error('✗ Failed to connect to RabbitMQ:', error.message);
    throw error;
  }
}

async function publishEvent(eventType, data, exchange = 'analytics') {
  try {
    if (!channel) await connect();
    
    const message = JSON.stringify({
      eventType,
      timestamp: new Date().toISOString(),
      data
    });
    
    await channel.publish(
      exchange,
      eventType,
      Buffer.from(message),
      { persistent: true }
    );
    
    console.log(`📤 Event published: ${eventType}`);
  } catch (error) {
    console.error(`Failed to publish ${eventType}:`, error.message);
    throw error;
  }
}

async function subscribeToEvent(eventType, handler, exchange = 'analytics') {
  try {
    if (!channel) await connect();
    
    const queue = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue.queue, exchange, eventType);
    
    await channel.consume(queue.queue, async (msg) => {
      try {
        const content = JSON.parse(msg.content.toString());
        console.log(`📥 Event received: ${eventType}`);
        await handler(content.data);
        channel.ack(msg);
      } catch (error) {
        console.error(`Error handling ${eventType}:`, error.message);
        channel.nack(msg, false, true);
      }
    });
    
    console.log(`✓ Subscribed to ${eventType}`);
  } catch (error) {
    console.error(`Failed to subscribe to ${eventType}:`, error.message);
    throw error;
  }
}

async function close() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    console.log('RabbitMQ connection closed');
  } catch (error) {
    console.error('Error closing RabbitMQ connection:', error.message);
  }
}

module.exports = {
  connect,
  publishEvent,
  subscribeToEvent,
  close,
  EVENTS
};
