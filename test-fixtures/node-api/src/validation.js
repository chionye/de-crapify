// Validate a user payload for creation
export function validateUser(input) {
  // Create the errors array
  const errors = [];
  // Check the name
  if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
    errors.push('name');
  }
  // Check the email
  if (!input.email || typeof input.email !== 'string' || !input.email.includes('@')) {
    errors.push('email');
  }
  // Check the age
  if (input.age !== undefined && (typeof input.age !== 'number' || input.age < 0 || input.age > 150)) {
    errors.push('age');
  }
  // Return the errors
  return errors;
}

// Validate a user payload for updates (all fields optional)
export function validateUserUpdate(input) {
  // Create the errors array
  const errors = [];
  // Check the name if present
  if (input.name !== undefined) {
    if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      errors.push('name');
    }
  }
  // Check the email if present
  if (input.email !== undefined) {
    if (!input.email || typeof input.email !== 'string' || !input.email.includes('@')) {
      errors.push('email');
    }
  }
  // Check the age
  if (input.age !== undefined && (typeof input.age !== 'number' || input.age < 0 || input.age > 150)) {
    errors.push('age');
  }
  // Return the errors
  return errors;
}
