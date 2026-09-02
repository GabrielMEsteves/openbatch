import { useState } from 'react';
import { jwtDecode } from 'jwt-decode';
import LoginPage from './pages/LoginPage.jsx';
import Dashboard from './pages/Dashboard.jsx';

// Estilos globais
import './styles/main.css';
import './styles/components.css';
import './styles/sections.css';

function readInitialSession() {
  const token = localStorage.getItem('authToken');
  if (!token) return { token: null, username: null };

  try {
    const decodedToken = jwtDecode(token);
    return { token, username: decodedToken.username };
  } catch (error) {
    console.error("Token inválido:", error);
    localStorage.removeItem('authToken');
    return { token: null, username: null };
  }
}

function App() {
  const [initialSession] = useState(readInitialSession);
  const [authToken, setAuthToken] = useState(initialSession.token);
  const [currentUser, setCurrentUser] = useState(initialSession.username);

  const handleLogin = (token) => {
    localStorage.setItem('authToken', token);
    setAuthToken(token);
    try {
      const decodedToken = jwtDecode(token);
      setCurrentUser(decodedToken.username);
    } catch (error) {
      console.error("Erro no login:", error);
    }
  };

  const handleLogout = () => {
    console.log("Logout acionado!");
    localStorage.removeItem('authToken');
    setAuthToken(null);
    setCurrentUser(null);
  };

  return (
    <>
      {authToken ? (
        <Dashboard user={currentUser} onLogout={handleLogout} />
      ) : (
        <LoginPage onLogin={handleLogin} />
      )}
    </>
  );
}

export default App;
