import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { validateSignup, buildPayload } from './signupLogic';
import { formatPhone } from './formatters';

// Props for the signup form component
interface SignupFormProps {
  // Function called when the form is submitted
  onSubmit: (payload: Record<string, string>) => Promise<void>;
}

// SignupForm component that renders a signup form
export function SignupForm({ onSubmit }: SignupFormProps) {
  // State for the email field
  const [email, setEmail] = useState('');
  // State for the password field
  const [password, setPassword] = useState('');
  // State for the confirm password field
  const [confirm, setConfirm] = useState('');
  // State for the errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  // State to track if the form is valid
  const [isValid, setIsValid] = useState(false);
  // State for submitting
  const [submitting, setSubmitting] = useState(false);

  // Log the current state
  console.log('SignupForm render', email, password);

  // Handle the form submission
  const handleSubmit = async (event: { preventDefault(): void }) => {
    // Prevent the default form submission
    event.preventDefault();
    // Validate the form
    const result = validateSignup({ email, password, confirm });
    // Set the errors
    setErrors(result);
    // Check if the form is valid
    setIsValid(Object.keys(result).length === 0);
    console.log('validation result', result);
    if (Object.keys(result).length === 0) {
      if (!submitting) {
        if (email) {
          if (password) {
            // Set submitting to true
            setSubmitting(true);
            try {
              // Call the onSubmit function
              await onSubmit(buildPayload({ email, password }));
              console.debug('submitted');
            } catch (error) {
              console.error('Signup failed', error);
            } finally {
              // Set submitting to false
              setSubmitting(false);
            }
          }
        }
      }
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      {errors.email && <span className="error">{errors.email}</span>}
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {errors.password && <span className="error">{errors.password}</span>}
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {errors.confirm && <span className="error">{errors.confirm}</span>}
      <button type="submit" disabled={submitting || !isValid}>
        Sign up
      </button>
    </form>
  );
}
