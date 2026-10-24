import java.io.IOException;
public class Coverage {
  static void fail() throws IOException { throw new IOException("ввод"); }
  public static void main(String[] args) {
    int value = 1;
    try {
      try { fail(); }
      catch (IOException | IllegalArgumentException error) {
        throw new IllegalStateException(error.getMessage());
      } finally { System.out.println("первый " + value); }
    } catch (RuntimeException error) {
      System.out.println(error.getClass().getSimpleName() + ":" + error.getMessage());
    } finally { System.out.println("второй"); }
  }
}
