/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/frontend/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        brandRed: '#ef233c',
        brandRedDark: '#d90429',
        brandGreen: '#0f7a43',
        brandGreenMid: '#16a34a'
      }
    }
  },
  plugins: []
};

