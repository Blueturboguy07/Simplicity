import PublikBanner from '@/components/Publik/PublikBanner';

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    <main className="lg:pl-20 bg-light-primary dark:bg-dark-primary min-h-screen">
      <div className="max-w-screen-lg lg:mx-auto mx-4">
        {/* publik money banner: only renders on a 402 or a low starter */}
        <PublikBanner />
        {children}
      </div>
    </main>
  );
};

export default Layout;
