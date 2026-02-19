#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DATABASE,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Test database connection
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Create MCP server
const server = new Server(
  {
    name: 'postgres-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query_database',
        description: 'Execute a SQL query on the PostgreSQL database. Returns the query results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'SQL query to execute (e.g., SELECT * FROM users WHERE id = 1)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables in the database',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'describe_table',
        description: 'Get the schema/structure of a specific table',
        inputSchema: {
          type: 'object',
          properties: {
            table_name: {
              type: 'string',
              description: 'Name of the table to describe',
            },
          },
          required: ['table_name'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'query_database') {
      const { query } = args;
      
      if (!query) {
        throw new Error('Query parameter is required');
      }

      const result = await pool.query(query);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rowCount: result.rowCount,
              rows: result.rows,
              fields: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
            }, null, 2),
          },
        ],
      };
    } else if (name === 'list_tables') {
      const result = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name;
      `);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              tables: result.rows.map(row => row.table_name)
            }, null, 2),
          },
        ],
      };
    } else if (name === 'describe_table') {
      const { table_name } = args;
      
      if (!table_name) {
        throw new Error('table_name parameter is required');
      }

      const result = await pool.query(`
        SELECT 
          column_name,
          data_type,
          character_maximum_length,
          column_default,
          is_nullable
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position;
      `, [table_name]);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              table: table_name,
              columns: result.rows
            }, null, 2),
          },
        ],
      };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'explore_database',
        description: 'Get an overview of the database structure and explore tables',
        arguments: [],
      },
      {
        name: 'analyze_table',
        description: 'Analyze a specific table with sample data and statistics',
        arguments: [
          {
            name: 'table_name',
            description: 'Name of the table to analyze',
            required: true,
          },
        ],
      },
    ],
  };
});

// Handle prompt requests
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'explore_database') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Please list all tables in the database and provide a brief overview of the database structure.',
          },
        },
      ],
    };
  } else if (name === 'analyze_table') {
    const tableName = args?.table_name;
    
    if (!tableName) {
      throw new Error('table_name argument is required');
    }

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze the table "${tableName}". Show me:
1. The table schema (columns, data types)
2. Row count
3. Sample data (first 5 rows)
4. Any interesting patterns or insights`,
          },
        },
      ],
    };
  } else {
    throw new Error(`Unknown prompt: ${name}`);
  }
});

// Start the server
async function main() {
  // Test database connection
  try {
    const client = await pool.connect();
    console.error('✓ Successfully connected to PostgreSQL database');
    client.release();
  } catch (err) {
    console.error('✗ Failed to connect to PostgreSQL database:', err.message);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Postgres server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
