import express from 'express';
import usersRouter from './routes/users.js';
import { createServer } from 'node:http';
import path from 'path';

const app = express();
app.use(express.json());
app.use('/users', usersRouter);

const port = Number(process.env.PORT ?? 3000);
createServer(app).listen(port, () => {
  console.info(`listening on ${port}`);
});
