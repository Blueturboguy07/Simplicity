/* The answer-slot skeleton. It lives inside the answer column now (see
   MessageBox's pending indicator), so it fills its container instead of
   setting its own width. */
const MessageBoxLoading = () => {
  return (
    <div className="flex flex-col space-y-2 w-full animate-pulse py-1">
      <div className="h-2 rounded-full w-full bg-light-secondary dark:bg-dark-secondary" />
      <div className="h-2 rounded-full w-9/12 bg-light-secondary dark:bg-dark-secondary" />
      <div className="h-2 rounded-full w-10/12 bg-light-secondary dark:bg-dark-secondary" />
    </div>
  );
};

export default MessageBoxLoading;
