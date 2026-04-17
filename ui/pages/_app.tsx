import "../styles/globals.css";

type AppProps = {
  Component: React.ComponentType<Record<string, unknown>>;
  pageProps: Record<string, unknown>;
};

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
