type User = { id: string; name: string; email: string; age?: number };

const rows = new Map<string, User>();
let counter = 0;

export const db = {
  users: {
    async findAll(): Promise<User[]> {
      return [...rows.values()];
    },
    async create(data: Omit<User, 'id'>): Promise<User> {
      const user = { id: String(++counter), ...data };
      rows.set(user.id, user);
      return user;
    },
    async update(id: string, data: Partial<User>): Promise<User | undefined> {
      const existing = rows.get(id);
      if (!existing) return undefined;
      const user = { ...existing, ...data, id };
      rows.set(id, user);
      return user;
    },
  },
};
