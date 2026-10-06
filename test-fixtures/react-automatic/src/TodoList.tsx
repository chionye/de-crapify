import React, { useState, useCallback, useEffect } from 'react';
import { addTodo, toggleTodo, visibleTodos, type Todo } from './todoLogic';

// Type for the filter
type Filter = 'all' | 'active' | 'done';

// TodoList component
export default function TodoList() {
  // State for the list of todos
  const [todos, setTodos] = useState<Todo[]>([]);
  // State for the input text
  const [text, setText] = useState('');
  // State for the current filter
  const [filter, setFilter] = useState<Filter>('all');
  // State for the count of todos
  const [count, setCount] = useState(0);

  // Update the count whenever todos change
  useEffect(() => {
    // Set the count
    setCount(todos.length);
    console.log('todos changed', todos);
  }, [todos]);

  // Handle adding a todo
  const handleAdd = () => {
    // Check if text is not empty
    if (text.trim() !== '') {
      // Add the todo
      const next = addTodo(todos, text);
      // Update the todos
      setTodos(next);
      // Clear the text
      setText('');
    }
  };

  // Get the visible todos
  const shown = visibleTodos(todos, filter);

  return (
    <div className="todo-list">
      <h1>Todos ({count})</h1>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={handleAdd}>Add</button>
      <div>
        {(['all', 'active', 'done'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} disabled={f === filter}>
            {f}
          </button>
        ))}
      </div>
      <ul>
        {shown.map((todo) => (
          <li key={todo.id} onClick={() => setTodos(toggleTodo(todos, todo.id))}>
            {todo.done ? <s>{todo.text}</s> : todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
