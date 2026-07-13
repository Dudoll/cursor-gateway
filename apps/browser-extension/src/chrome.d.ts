declare namespace chrome {
  namespace action {
    const onClicked: {
      addListener(callback: () => void): void;
    };
  }

  namespace tabs {
    function create(options: { url: string }): Promise<unknown>;
  }

  namespace permissions {
    function request(options: { origins: string[] }): Promise<boolean>;
    function contains(options: { origins: string[] }): Promise<boolean>;
  }

  namespace runtime {
    function getURL(path: string): string;
  }
}
