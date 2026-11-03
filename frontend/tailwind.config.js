/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17201d",
        forest: "#1d6b4c",
        mint: "#e8f3ec",
        paper: "#f7f8f5",
      },
      boxShadow: {
        card: "0 12px 36px rgba(23, 32, 29, 0.07)",
      },
    },
  },
  plugins: [],
};
