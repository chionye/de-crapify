import express, { type Request, type Response } from 'express';
import { body, validationResult } from 'express-validator-pro';
import { db } from '../lib/db.js';
import { sanitizeInput } from './helpers/sanitize';
import { validateUser } from '../validation.js';

const router = express.Router();

// GET all users
router.get('/', async (_req: Request, res: Response) => {
  // Fetch all users from the database
  const users = await db.users.findAll();
  console.log('fetched users', users.length);
  // Return the users
  res.json(users);
});

// POST create a user
router.post('/', body('email').isEmail(), async (req: Request, res: Response) => {
  // Check the validation result
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ errors: result.array() });
  }
  // Validate the request body
  const { name, email, age } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (age !== undefined && (typeof age !== 'number' || age < 0 || age > 150)) {
    return res.status(400).json({ error: 'Age must be between 0 and 150' });
  }
  // Create the user
  const user = await db.users.create({ name: sanitizeInput(name), email, age });
  console.log('created user', user.id);
  // Return the created user
  res.status(201).json(user);
});

// PUT update a user
router.put('/:id', async (req: Request, res: Response) => {
  // Validate the request body
  const { name, email, age } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (age !== undefined && (typeof age !== 'number' || age < 0 || age > 150)) {
    return res.status(400).json({ error: 'Age must be between 0 and 150' });
  }
  // Update the user
  const user = await db.users.update(req.params.id, { name, email, age });
  // Return the updated user
  res.json(user);
});

export default router;
