// Regular expression to validate email addresses
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimum password length
const MIN_PASSWORD_LENGTH = 8;

// Function to validate the signup form values
export function validateSignup(values) {
  // Create an empty errors object
  const errors = {};
  // Get the email from the values
  const email = values.email;
  // Check if the email is empty
  if (!email) {
    // Set the email error
    errors.email = 'Email is required';
  } else {
    // Check if the email is valid
    if (!EMAIL_PATTERN.test(email)) {
      // Set the email error
      errors.email = 'Email is invalid';
    }
  }
  // Get the password from the values
  const password = values.password;
  // Check if the password is empty
  if (!password) {
    errors.password = 'Password is required';
  } else {
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
  }
  // Check if the passwords match
  if (values.confirm !== password) {
    // Set the confirm error
    errors.confirm = 'Passwords do not match';
  }
  console.log('validateSignup', errors);
  // Return the errors
  return errors;
}

// Function to build the payload for the API
export function buildPayload(values) {
  // Trim the email
  const trimmedEmail = values.email.trim();
  // Lowercase the email
  const normalizedEmail = trimmedEmail.toLowerCase();
  // Create the payload object
  const payload = { email: normalizedEmail, password: values.password };
  // Return the payload
  return payload;
}
