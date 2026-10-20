-- البيانات المبدئية: مناطق التشغيل ونقاط الركوب في مدينة كفر صقر
-- الأسماء مأخوذة من عناوين حقيقية في دليل المدينة — عدّلها من التطبيق بعد المعاينة الميدانية

DELETE FROM docs WHERE kind IN ('zones','places','config');

INSERT INTO docs (kind,id,data,updated) VALUES
('config','pricing','{"same":10,"cross":15,"cutKm":2,"paidFrom":"","week":30,"month":100,"grace":3}',0);

INSERT INTO docs (kind,id,data,updated) VALUES
('zones','z0','{"id":"z0","name":"وسط البلد — التحرير","official":false,"order":0}',0),
('zones','z1','{"id":"z1","name":"الجلاء وعمر أفندي","official":false,"order":1}',0),
('zones','z2','{"id":"z2","name":"حي النصر","official":true,"order":2}',0),
('zones','z3','{"id":"z3","name":"المحطة والجيش","official":false,"order":3}',0),
('zones','z4','{"id":"z4","name":"المستشفى المركزي","official":false,"order":4}',0),
('zones','z5','{"id":"z5","name":"شارع البحر","official":false,"order":5}',0),
('zones','z6','{"id":"z6","name":"العرب والساحة","official":false,"order":6}',0);

INSERT INTO docs (kind,id,data,updated) VALUES
('places','p0','{"id":"p0","name":"شارع التحرير","zoneId":"z0","lat":null,"lng":null,"order":0}',0),
('places','p1','{"id":"p1","name":"بنك مصر","zoneId":"z0","lat":null,"lng":null,"order":1}',0),
('places','p2','{"id":"p2","name":"السنترال","zoneId":"z0","lat":null,"lng":null,"order":2}',0),
('places','p3','{"id":"p3","name":"مكتب البريد","zoneId":"z0","lat":null,"lng":null,"order":3}',0),
('places','p4','{"id":"p4","name":"شارع الجمهورية","zoneId":"z0","lat":null,"lng":null,"order":4}',0),
('places','p5','{"id":"p5","name":"شارع الجلاء","zoneId":"z1","lat":null,"lng":null,"order":5}',0),
('places','p6','{"id":"p6","name":"عمر أفندي","zoneId":"z1","lat":null,"lng":null,"order":6}',0),
('places','p7','{"id":"p7","name":"مجلس المدينة","zoneId":"z1","lat":null,"lng":null,"order":7}',0),
('places','p8','{"id":"p8","name":"حي النصر","zoneId":"z2","lat":null,"lng":null,"order":8}',0),
('places','p9','{"id":"p9","name":"قسم الشرطة","zoneId":"z2","lat":null,"lng":null,"order":9}',0),
('places','p10','{"id":"p10","name":"شارع مضيفة","zoneId":"z2","lat":null,"lng":null,"order":10}',0),
('places','p11','{"id":"p11","name":"محطة السكة الحديد","zoneId":"z3","lat":null,"lng":null,"order":11}',0),
('places','p12','{"id":"p12","name":"شارع الجيش","zoneId":"z3","lat":null,"lng":null,"order":12}',0),
('places','p13','{"id":"p13","name":"مكتب العمل","zoneId":"z3","lat":null,"lng":null,"order":13}',0),
('places','p14','{"id":"p14","name":"مستشفى كفر صقر المركزي","zoneId":"z4","lat":null,"lng":null,"order":14}',0),
('places','p15','{"id":"p15","name":"شارع المستشفى","zoneId":"z4","lat":null,"lng":null,"order":15}',0),
('places','p16','{"id":"p16","name":"الإدارة الصحية","zoneId":"z4","lat":null,"lng":null,"order":16}',0),
('places','p17','{"id":"p17","name":"شارع البحر","zoneId":"z5","lat":null,"lng":null,"order":17}',0),
('places','p18','{"id":"p18","name":"مستشفى الزهراء","zoneId":"z5","lat":null,"lng":null,"order":18}',0),
('places','p19','{"id":"p19","name":"الكوبري","zoneId":"z5","lat":null,"lng":null,"order":19}',0),
('places','p20','{"id":"p20","name":"شارع العرب","zoneId":"z6","lat":null,"lng":null,"order":20}',0),
('places','p21','{"id":"p21","name":"شارع الساحة","zoneId":"z6","lat":null,"lng":null,"order":21}',0),
('places','p22','{"id":"p22","name":"شارع السباعي","zoneId":"z6","lat":null,"lng":null,"order":22}',0),
('places','p23','{"id":"p23","name":"شارع عبد المنعم","zoneId":"z6","lat":null,"lng":null,"order":23}',0);
