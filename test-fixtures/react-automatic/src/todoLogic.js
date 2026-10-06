/**
 * @typedef {{ id: number, text: string, done: boolean }} Todo
 */

let nextId = 1;

// Function to add a todo to the list
export function addTodo(todos, text) {
  // Create the new todo
  const todo = { id: nextId++, text: text.trim(), done: false };
  // Create a new array with the todo
  const result = [...todos, todo];
  // Return the result
  return result;
}

// Function to toggle a todo
export function toggleTodo(todos, id) {
  // Map over the todos
  return todos.map((todo) => {
    // Check if this is the todo to toggle
    if (todo.id === id) {
      // Return the toggled todo
      return { ...todo, done: !todo.done };
    } else {
      // Return the todo unchanged
      return todo;
    }
  });
}

// Function to get the visible todos for a filter
export function visibleTodos(todos, filter) {
  // Check the filter
  if (filter === 'all') {
    // Return all todos
    return todos;
  } else {
    if (filter === 'active') {
      // Return only active todos
      return todos.filter((todo) => !todo.done);
    } else {
      if (filter === 'done') {
        // Return only done todos
        return todos.filter((todo) => todo.done);
      }
    }
  }
  console.warn('unknown filter', filter);
  return todos;
}

// Reset the id counter (used by tests)
export function resetIds() {
  nextId = 1;
}
