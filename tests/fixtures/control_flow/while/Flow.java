public class Flow {
  public static void main(String[] args) {
    int n = 0, total = 0;
    while (n < 4) {
      n++;
      if (n == 2) continue;
      total += n;
      if (total > 5) break;
    }
    System.out.println(total);
  }
}
