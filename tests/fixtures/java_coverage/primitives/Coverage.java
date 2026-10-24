public class Coverage {
  public static void main(String[] args) {
    byte b = 2; short s = 3; int i = 4; long l = 5L;
    float f = 1.5f; double d = 2.5; char c = 'Я'; boolean ok = true;
    Byte wb = b; Short ws = s; Integer wi = i; Long wl = l;
    Float wf = f; Double wd = d; Character wc = c; Boolean wo = ok;
    int[] values = {wb, ws, wi, wl.intValue()};
    int total = 0;
    for (int value : values) total += value;
    boolean logic = wo && total == 14 && wf < wd && wc == 'Я' || false;
    total += (int) Math.abs(-2.8);
    String text = new StringBuilder().append(c).append(':').append(total).toString();
    Object object = text;
    System.out.println(object.toString() + ":" + logic + ":" + Integer.parseInt("7"));
  }
}
